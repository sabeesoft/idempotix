import { metrics as otelMetrics, type Attributes, type MeterProvider } from '@opentelemetry/api';
import {
  DB_SYSTEM_POSTGRESQL,
  IDEMPOTIX_METER_NAME,
  IDEMPOTIX_METER_VERSION,
  errorType,
  instrumentPgPool,
  secondsSince,
} from '@sabeesoft/idempotix-pg';
import type pg from 'pg';

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
    IDEMPOTIX_METER_NAME,
    IDEMPOTIX_METER_VERSION,
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
      const attrs: Attributes = {
        'db.system.name': DB_SYSTEM_POSTGRESQL,
        'db.operation.name': operation,
      };
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

  if (options.pool) {
    const instrumented = instrumentPgPool({
      pool: options.pool,
      ...(options.poolName === undefined ? {} : { poolName: options.poolName }),
      ...(options.meterProvider === undefined ? {} : { meterProvider: options.meterProvider }),
    });
    disposers.push(instrumented.dispose);
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
