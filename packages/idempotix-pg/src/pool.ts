import { metrics as otelMetrics, type Attributes, type MeterProvider } from '@opentelemetry/api';
import type pg from 'pg';

export const IDEMPOTIX_METER_NAME = 'idempotix';
export const IDEMPOTIX_METER_VERSION = '0.0.0';
export const DB_SYSTEM_POSTGRESQL = 'postgresql';

/** A bounded identifier for an error: its `code` (e.g. a driver error code) or class name. */
export function errorType(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) {
      return name;
    }
  }
  return 'Error';
}

export function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}

export interface InstrumentPgPoolOptions {
  pool: pg.Pool;
  /** `db.client.connection.pool.name` attribute. Default `"default"`. */
  poolName?: string;
  /** Defaults to the API's global provider — a no-op until an SDK registers one. */
  meterProvider?: MeterProvider;
}

export interface InstrumentedPgPool {
  /** Removes the pool listeners, restores `pool.connect`, and stops the observable callbacks. */
  dispose: () => void;
}

/**
 * OpenTelemetry `db.client.connection.*` metrics for a `pg.Pool`, following the
 * OTel database semantic conventions. Attributes are the pool name (and the
 * connection state / error code) only.
 *
 * `pg` emits no "waiting" event, so acquisition latency and timeouts are
 * measured around `pool.connect()` — the one entry point `pool.query()` uses
 * too. Everything else comes from public stats and events.
 */
export function instrumentPgPool(options: InstrumentPgPoolOptions): InstrumentedPgPool {
  const { pool } = options;
  const meter = (options.meterProvider ?? otelMetrics.getMeterProvider()).getMeter(
    IDEMPOTIX_METER_NAME,
    IDEMPOTIX_METER_VERSION,
  );
  const poolAttrs: Attributes = { 'db.client.connection.pool.name': options.poolName ?? 'default' };
  const disposers: (() => void)[] = [];

  const count = meter.createObservableUpDownCounter('db.client.connection.count', {
    description: 'Connections in the pool by state',
    unit: '{connection}',
  });
  const max = meter.createObservableUpDownCounter('db.client.connection.max', {
    description: 'Maximum number of connections the pool may open',
    unit: '{connection}',
  });
  const pending = meter.createObservableUpDownCounter('db.client.connection.pending_requests', {
    description: 'Requests waiting for a connection',
    unit: '{request}',
  });
  const observe = (result: {
    observe(instrument: unknown, value: number, attrs?: Attributes): void;
  }): void => {
    result.observe(count, pool.idleCount, { ...poolAttrs, 'db.client.connection.state': 'idle' });
    result.observe(count, pool.totalCount - pool.idleCount, {
      ...poolAttrs,
      'db.client.connection.state': 'used',
    });
    result.observe(max, pool.options.max, poolAttrs);
    result.observe(pending, pool.waitingCount, poolAttrs);
  };
  meter.addBatchObservableCallback(observe, [count, max, pending]);
  disposers.push(() => {
    meter.removeBatchObservableCallback(observe, [count, max, pending]);
  });

  const waitTime = meter.createHistogram('db.client.connection.wait_time', {
    description: 'Time spent waiting to acquire a connection from the pool',
    unit: 's',
  });
  const useTime = meter.createHistogram('db.client.connection.use_time', {
    description: 'Time a connection was checked out of the pool',
    unit: 's',
  });
  const timeouts = meter.createCounter('db.client.connection.timeouts', {
    description: 'Connection acquisitions that timed out',
    unit: '{timeout}',
  });
  const poolErrors = meter.createCounter('idempotix.db.pool.errors', {
    description: 'Errors emitted by idle connections in the pool',
    unit: '{error}',
  });

  // Captured unbound on purpose: it is restored onto the same pool by dispose().
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalConnect = pool.connect;
  type ConnectCallback = (err: Error | undefined, ...rest: unknown[]) => void;
  // `pg.Pool.connect` has a promise form and a callback form; keep both.
  const connectPromise = originalConnect as unknown as (this: pg.Pool) => Promise<pg.PoolClient>;
  const connectCallback = originalConnect as unknown as (
    this: pg.Pool,
    callback: ConnectCallback,
  ) => void;
  const wrappedConnect = function (this: pg.Pool, callback?: ConnectCallback): unknown {
    const start = process.hrtime.bigint();
    const finish = (err: unknown): void => {
      waitTime.record(secondsSince(start), poolAttrs);
      if (err instanceof Error && /timeout/i.test(err.message)) {
        timeouts.add(1, poolAttrs);
      }
    };
    if (callback) {
      connectCallback.call(this, (err, ...rest) => {
        finish(err);
        callback(err, ...rest);
      });
      return undefined;
    }
    return connectPromise.call(this).then(
      (c) => {
        finish(undefined);
        return c;
      },
      (err: unknown) => {
        finish(err);
        throw err;
      },
    );
  };
  pool.connect = wrappedConnect as pg.Pool['connect'];
  disposers.push(() => {
    pool.connect = originalConnect;
  });

  const checkedOut = new WeakMap<object, bigint>();
  const onAcquire = (client: pg.PoolClient): void => {
    checkedOut.set(client, process.hrtime.bigint());
  };
  const onRelease = (_err: Error | undefined, client: pg.PoolClient): void => {
    const start = checkedOut.get(client);
    if (start !== undefined) {
      checkedOut.delete(client);
      useTime.record(secondsSince(start), poolAttrs);
    }
  };
  const onError = (err: Error): void => {
    poolErrors.add(1, { ...poolAttrs, 'error.type': errorType(err) });
  };
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  pool.on('error', onError);
  disposers.push(() => {
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
    pool.off('error', onError);
  });

  return {
    dispose: () => {
      for (const dispose of disposers.splice(0)) {
        dispose();
      }
    },
  };
}
