import { metrics as otelMetrics, type Attributes, type MeterProvider } from '@opentelemetry/api';
import type pg from 'pg';

const METER_NAME = 'idempotix';
const METER_VERSION = '0.0.0';
const DB_SYSTEM = 'postgresql';

interface QueryHookArgs {
  model?: string | undefined;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}
type QueryHook = (params: QueryHookArgs) => Promise<unknown>;

/** The slice of a Prisma client `instrumentPrisma` needs: `$extends` with a `query` component. */
export interface ExtendableClient {
  $extends(extension: {
    query: {
      $allModels: { $allOperations: QueryHook };
      $queryRaw: QueryHook;
      $executeRaw: QueryHook;
      $queryRawUnsafe: QueryHook;
      $executeRawUnsafe: QueryHook;
    };
  }): unknown;
}

export interface InstrumentPrismaOptions<TClient extends ExtendableClient> {
  /** The Prisma client to wrap with `db.client.operation.duration`. The returned `client` must be the one the app uses. */
  client?: TClient;
  /** The `pg.Pool` behind `@prisma/adapter-pg`, for `db.client.connection.*` metrics. */
  pool?: pg.Pool;
  /** `db.client.connection.pool.name` attribute. Default `"default"`. */
  poolName?: string;
  /** Set to `false` to keep `client` uninstrumented while still instrumenting the pool. Default `true`. */
  queries?: boolean;
  /** Defaults to the API's global provider — a no-op until an SDK registers one. */
  meterProvider?: MeterProvider;
}

export interface InstrumentedPrisma<TClient> {
  /** The client to use from now on: the extended one when `queries` is on, the original otherwise. */
  client: TClient;
  /** Removes pool listeners, restores `pool.connect`, and stops the observable callbacks. */
  dispose: () => void;
}

function errorType(err: unknown): string {
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

function secondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}

/**
 * OpenTelemetry instrumentation for a Prisma 7 + `pg` setup, usable with or
 * without the rest of idempotix. Emits OTel database semantic-convention
 * metrics (`db.client.*`) with low-cardinality attributes only: operation
 * and model names, pool name, error codes — never query text or arguments.
 */
export function instrumentPrisma<TClient extends ExtendableClient>(
  options: InstrumentPrismaOptions<TClient>,
): InstrumentedPrisma<TClient> {
  const meter = (options.meterProvider ?? otelMetrics.getMeterProvider()).getMeter(
    METER_NAME,
    METER_VERSION,
  );
  const disposers: (() => void)[] = [];

  // `client` is undefined when only the pool is instrumented; the generic is
  // whatever the caller passed, so this is a widening, not a null removal.
  // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
  let client = options.client as TClient;
  if (options.client && options.queries !== false) {
    const operationDuration = meter.createHistogram('db.client.operation.duration', {
      description: 'Duration of database client operations',
      unit: 's',
    });
    const hook: QueryHook = async ({ model, operation, args, query }) => {
      const attrs: Attributes = { 'db.system.name': DB_SYSTEM, 'db.operation.name': operation };
      if (model !== undefined) {
        attrs['db.collection.name'] = model;
      }
      const start = process.hrtime.bigint();
      try {
        const result = await query(args);
        operationDuration.record(secondsSince(start), attrs);
        return result;
      } catch (err) {
        operationDuration.record(secondsSince(start), { ...attrs, 'error.type': errorType(err) });
        throw err;
      }
    };
    client = options.client.$extends({
      query: {
        $allModels: { $allOperations: hook },
        $queryRaw: hook,
        $executeRaw: hook,
        $queryRawUnsafe: hook,
        $executeRawUnsafe: hook,
      },
    }) as TClient;
  }

  const pool = options.pool;
  if (pool) {
    const poolAttrs: Attributes = {
      'db.client.connection.pool.name': options.poolName ?? 'default',
    };

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

    // `pg` has no "waiting" event, so acquisition latency and timeouts can only
    // be observed around `connect()` — the one entry point `pool.query()` uses too.
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
  }

  return {
    client,
    dispose: () => {
      for (const dispose of disposers.splice(0)) {
        dispose();
      }
    },
  };
}
