/**
 * @sabeesoft/idempotix-pg
 *
 * Shared PostgreSQL support for idempotix adapters: the idempotency-table SQL
 * and row mapping every Postgres adapter uses, plus OpenTelemetry
 * instrumentation for a `pg.Pool`. Not an adapter itself.
 */

export type { AcquireRow, IdempotencyRow, PostgresIdempotencySql } from './sql.js';
export {
  DEFAULT_TABLE_NAME,
  postgresIdempotencySql,
  quoteTableName,
  toIdempotencyRecord,
} from './sql.js';

export type { InstrumentPgPoolOptions, InstrumentedPgPool } from './pool.js';
export {
  DB_SYSTEM_POSTGRESQL,
  IDEMPOTIX_METER_NAME,
  IDEMPOTIX_METER_VERSION,
  errorType,
  instrumentPgPool,
  secondsSince,
} from './pool.js';
