/**
 * @sabeesoft/idempotix-typeorm
 *
 * TypeORM / PostgreSQL store adapter for idempotix, the reference entity, and
 * OpenTelemetry instrumentation for a TypeORM `DataSource`.
 */

export type { EntityManagerLike, TypeormIdempotencyStoreOptions } from './store.js';
export { createTypeormIdempotencyStore } from './store.js';

export { IdempotencyKeyEntity } from './entity.js';

export type {
  DataSourceLike,
  InstrumentTypeormOptions,
  InstrumentedTypeorm,
} from './instrumentation.js';
export { instrumentTypeorm, operationName } from './instrumentation.js';
