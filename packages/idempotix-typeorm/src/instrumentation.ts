import { metrics as otelMetrics, type Attributes, type MeterProvider } from '@opentelemetry/api';
import {
  DB_SYSTEM_POSTGRESQL,
  IDEMPOTIX_METER_NAME,
  IDEMPOTIX_METER_VERSION,
  errorType,
  instrumentPgPool,
} from '@sabeesoft/idempotix-pg';
import type pg from 'pg';

/** The slice of a TypeORM `AfterQueryEvent` used here. */
interface AfterQueryEventLike {
  query: string;
  success: boolean;
  executionTime?: number | undefined;
  error?: unknown;
}

interface QuerySubscriber {
  afterQuery(event: AfterQueryEventLike): void;
}

/**
 * The slice of a TypeORM `DataSource` `instrumentTypeorm` needs. Structural so
 * the package never imports `typeorm` at runtime for this.
 */
export interface DataSourceLike {
  isInitialized: boolean;
  /** TypeORM's mutable subscriber list; the query subscriber is pushed here. */
  subscribers: object[];
  /** The Postgres driver keeps its `pg.Pool` in `driver.master`. */
  driver: object;
}

export interface InstrumentTypeormOptions {
  /** An initialized `DataSource` (call after `dataSource.initialize()`). */
  dataSource: DataSourceLike;
  /** `db.client.connection.pool.name` attribute. Default `"default"`. */
  poolName?: string;
  /** `db.client.operation.duration` via TypeORM's `afterQuery` subscriber. Default `true`. */
  queries?: boolean;
  /** `db.client.connection.*` on the Postgres driver's `pg.Pool`. Default `true`. */
  pool?: boolean;
  /** Defaults to the API's global provider — a no-op until an SDK registers one. */
  meterProvider?: MeterProvider;
}

export interface InstrumentedTypeorm {
  /** Removes the subscriber and the pool instrumentation. */
  dispose: () => void;
}

const KNOWN_OPERATIONS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'BEGIN',
  'START',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'SET',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
]);

/**
 * `db.operation.name` from raw SQL: its leading keyword, from a bounded set.
 * TypeORM hands us SQL text, and parsing table names out of it is neither
 * reliable nor safe for metric cardinality, so `db.collection.name` is not set.
 */
export function operationName(sql: string): string {
  const keyword = /^\s*(?:\/\*.*?\*\/\s*)*([A-Za-z]+)/s.exec(sql)?.[1]?.toUpperCase();
  return keyword !== undefined && KNOWN_OPERATIONS.has(keyword) ? keyword : 'OTHER';
}

/**
 * OpenTelemetry instrumentation for a TypeORM + PostgreSQL `DataSource`, usable
 * with or without the rest of idempotix. Query durations come from TypeORM's
 * own `afterQuery` subscriber event (no patching); pool metrics from the
 * driver's `pg.Pool`. Query text and parameters never become attributes.
 */
export function instrumentTypeorm(options: InstrumentTypeormOptions): InstrumentedTypeorm {
  const { dataSource } = options;
  if (!dataSource.isInitialized) {
    throw new Error('instrumentTypeorm() must be called after dataSource.initialize()');
  }
  const meter = (options.meterProvider ?? otelMetrics.getMeterProvider()).getMeter(
    IDEMPOTIX_METER_NAME,
    IDEMPOTIX_METER_VERSION,
  );
  const disposers: (() => void)[] = [];

  if (options.queries !== false) {
    const operationDuration = meter.createHistogram('db.client.operation.duration', {
      description: 'Duration of database client operations',
      unit: 's',
    });
    const subscriber: QuerySubscriber = {
      afterQuery(event) {
        const attrs: Attributes = {
          'db.system.name': DB_SYSTEM_POSTGRESQL,
          'db.operation.name': operationName(event.query),
        };
        if (!event.success) {
          attrs['error.type'] = errorType(event.error);
        }
        operationDuration.record((event.executionTime ?? 0) / 1000, attrs);
      },
    };
    dataSource.subscribers.push(subscriber);
    disposers.push(() => {
      const index = dataSource.subscribers.indexOf(subscriber);
      if (index >= 0) {
        dataSource.subscribers.splice(index, 1);
      }
    });
  }

  if (options.pool !== false) {
    const pool = (dataSource.driver as { master?: unknown }).master as pg.Pool | undefined;
    if (!pool || typeof pool.connect !== 'function') {
      throw new Error(
        'instrumentTypeorm() found no pg.Pool on dataSource.driver.master — only the postgres driver is supported',
      );
    }
    const instrumented = instrumentPgPool({
      pool,
      ...(options.poolName === undefined ? {} : { poolName: options.poolName }),
      ...(options.meterProvider === undefined ? {} : { meterProvider: options.meterProvider }),
    });
    disposers.push(instrumented.dispose);
  }

  return {
    dispose: () => {
      for (const dispose of disposers.splice(0)) {
        dispose();
      }
    },
  };
}
