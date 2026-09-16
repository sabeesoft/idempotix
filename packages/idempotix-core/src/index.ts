/**
 * @sabeesoft/idempotix-core
 *
 * Framework- and ORM-agnostic idempotency core: state machine orchestration,
 * fingerprinting, scope building, TTL policy, domain errors, ports, and an
 * in-memory reference store.
 */

export {
  IdempotixError,
  FingerprintMismatchError,
  ConflictInProgressError,
  UnsupportedPayloadValueError,
  InvalidTtlError,
  InvalidScopePartError,
} from './errors.js';

export type { Clock } from './clock.js';
export { SystemClock } from './clock.js';

export { generateKey } from './key.js';

export { parseTtlMs } from './ttl.js';

export type { ScopeParts } from './scope.js';
export { buildScope } from './scope.js';

export type { JsonValue } from './fingerprint.js';
export { fingerprint } from './fingerprint.js';

export type {
  IdempotencyStatus,
  IdempotencyRecord,
  TryAcquireInput,
  TryAcquireResult,
  FindForUpdateInput,
  MarkCompletedInput,
  PurgeExpiredInput,
  IdempotencyStore,
} from './store.js';

export { InMemoryIdempotencyStore } from './in-memory-store.js';

export type { IdempotencyOutcome, MetricAttributes, IdempotencyMetrics } from './metrics.js';
export { NoopMetrics } from './metrics.js';

export type { OrchestrateInput, OrchestrateResult } from './orchestrate.js';
export { runIdempotent } from './orchestrate.js';
