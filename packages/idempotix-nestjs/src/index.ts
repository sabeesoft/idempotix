/**
 * @sabeesoft/idempotix-nestjs
 *
 * NestJS integration for idempotix: `IdempotixModule`, the `@Idempotent()`
 * decorator, the interceptor that replays/rejects duplicate requests, and
 * `IdempotixService` for explicit, callback-style use.
 */

import 'reflect-metadata';

export type { IdempotixModuleOptions, OnMissingKey, ResolvedIdempotixOptions } from './options.js';
export { IDEMPOTIX_OPTIONS, IdempotixConfigurationError } from './options.js';

export type { IdempotentOptions } from './idempotent.decorator.js';
export { Idempotent } from './idempotent.decorator.js';

export { IDEMPOTENT_REPLAYED_HEADER, IdempotixInterceptor } from './idempotix.interceptor.js';

export type { IdempotentRunInput, IdempotentRunResult } from './idempotix.service.js';
export { IdempotixService } from './idempotix.service.js';

export type { IdempotixModuleAsyncOptions } from './idempotix.module.js';
export { IdempotixModule } from './idempotix.module.js';

export type { OtelIdempotencyMetricsOptions } from './otel-metrics.js';
export {
  IDEMPOTIX_METER_NAME,
  IDEMPOTIX_METER_VERSION,
  OtelIdempotencyMetrics,
} from './otel-metrics.js';
