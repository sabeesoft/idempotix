import type { Clock } from './clock.js';
import { ConflictInProgressError, FingerprintMismatchError } from './errors.js';
import { fingerprint, type JsonValue } from './fingerprint.js';
import type { IdempotencyMetrics } from './metrics.js';
import type { IdempotencyStore } from './store.js';

export interface OrchestrateInput {
  store: IdempotencyStore;
  metrics: IdempotencyMetrics;
  clock: Clock;
  /** Full scope (may embed a tenant id) — used for store lookups only. */
  scope: string;
  key: string;
  /** Low-cardinality route template (e.g. "POST /payments/:id") — used for metrics only. */
  route: string;
  payload: unknown;
  ttlMs: number;
  lockDurationMs: number;
  handler: () => Promise<{ responseCode: number; responseBody: JsonValue }>;
}

export interface OrchestrateResult {
  replayed: boolean;
  responseCode: number;
  responseBody: JsonValue;
}

export async function runIdempotent(input: OrchestrateInput): Promise<OrchestrateResult> {
  const { store, metrics, clock, scope, key, route, payload, ttlMs, lockDurationMs, handler } =
    input;
  const requestHash = fingerprint(payload);
  const now = clock.now();

  const acquireResult = await store.tryAcquire({ scope, key, requestHash, now, lockDurationMs });

  if (acquireResult.outcome === 'conflict') {
    const record = await store.findForUpdate({ scope, key });
    if (!record) {
      throw new Error(
        `Idempotency record for scope="${scope}" key="${key}" disappeared between tryAcquire and ` +
          'findForUpdate. This indicates a bug in the store adapter or an unexpected transaction ' +
          'isolation level, not a normal race — a reported conflict should always still be visible ' +
          'to a subsequent findForUpdate in the same transaction.',
      );
    }

    if (record.status === 'completed') {
      if (record.requestHash !== requestHash) {
        metrics.recordOutcome('fingerprint_mismatch', { route });
        throw new FingerprintMismatchError(scope, key);
      }
      metrics.recordOutcome('replayed', { route });
      return {
        replayed: true,
        responseCode: record.responseCode,
        responseBody: record.responseBody,
      };
    }

    metrics.recordOutcome('conflict', { route });
    throw new ConflictInProgressError(scope, key, record.lockedUntil.getTime() - now.getTime());
  }

  metrics.recordOutcome(acquireResult.reclaimed ? 'reclaimed' : 'acquired', { route });
  metrics.recordProcessingStarted({ route });
  const start = clock.now();
  try {
    const result = await handler();
    await store.markCompleted({
      scope,
      key,
      responseCode: result.responseCode,
      responseBody: result.responseBody,
      now: clock.now(),
      ttlMs,
    });
    metrics.recordHandlerDuration(elapsedSeconds(start, clock), { route, outcome: 'success' });
    return {
      replayed: false,
      responseCode: result.responseCode,
      responseBody: result.responseBody,
    };
  } catch (err) {
    metrics.recordHandlerDuration(elapsedSeconds(start, clock), { route, outcome: 'error' });
    throw err;
  } finally {
    metrics.recordProcessingEnded({ route });
  }
}

function elapsedSeconds(start: Date, clock: Clock): number {
  return (clock.now().getTime() - start.getTime()) / 1000;
}
