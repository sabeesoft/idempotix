import { describe, expect, it, vi } from 'vitest';
import type { Clock } from './clock.js';
import { ConflictInProgressError, FingerprintMismatchError } from './errors.js';
import { InMemoryIdempotencyStore } from './in-memory-store.js';
import type { IdempotencyMetrics, IdempotencyOutcome, MetricAttributes } from './metrics.js';
import { runIdempotent } from './orchestrate.js';

class FakeClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class RecordingMetrics implements IdempotencyMetrics {
  readonly outcomes: { outcome: IdempotencyOutcome; attrs: MetricAttributes }[] = [];
  processingStarted = 0;
  processingEnded = 0;
  readonly durations: { seconds: number; outcome: 'success' | 'error' }[] = [];

  recordOutcome(outcome: IdempotencyOutcome, attrs: MetricAttributes): void {
    this.outcomes.push({ outcome, attrs });
  }

  recordProcessingStarted(): void {
    this.processingStarted += 1;
  }

  recordProcessingEnded(): void {
    this.processingEnded += 1;
  }

  recordHandlerDuration(
    seconds: number,
    attrs: MetricAttributes & { outcome: 'success' | 'error' },
  ): void {
    this.durations.push({ seconds, outcome: attrs.outcome });
  }

  recordTransaction(): void {
    // core never runs transactions itself
  }
}

const ROUTE = 'POST /payments/:id';
const SCOPE = `acme${String.fromCharCode(31)}${ROUTE}`;

describe('runIdempotent', () => {
  it('runs the handler on a fresh acquire and returns its result', async () => {
    const store = new InMemoryIdempotencyStore();
    const metrics = new RecordingMetrics();
    const handler = vi.fn().mockResolvedValue({ responseCode: 201, responseBody: { id: 'p1' } });

    const result = await runIdempotent({
      store,
      metrics,
      clock: new FakeClock(new Date('2026-01-01T00:00:00Z')),
      scope: SCOPE,
      key: 'k1',
      route: ROUTE,
      payload: { amount: 100 },
      ttlMs: 3_600_000,
      lockDurationMs: 60_000,
      handler,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ replayed: false, responseCode: 201, responseBody: { id: 'p1' } });
    expect(metrics.outcomes.map((o) => o.outcome)).toEqual(['acquired']);
    expect(metrics.processingStarted).toBe(1);
    expect(metrics.processingEnded).toBe(1);
    expect(metrics.durations).toEqual([{ seconds: 0, outcome: 'success' }]);
  });

  it('replays the stored response for an identical payload without calling the handler again', async () => {
    const store = new InMemoryIdempotencyStore();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const handler = vi.fn().mockResolvedValue({ responseCode: 201, responseBody: { id: 'p1' } });
    const baseInput = {
      store,
      metrics: new RecordingMetrics(),
      clock,
      scope: SCOPE,
      key: 'k1',
      route: ROUTE,
      payload: { amount: 100 },
      ttlMs: 3_600_000,
      lockDurationMs: 60_000,
      handler,
    };

    await runIdempotent(baseInput);
    const replay = await runIdempotent({ ...baseInput, metrics: new RecordingMetrics() });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(replay).toEqual({ replayed: true, responseCode: 201, responseBody: { id: 'p1' } });
  });

  it('throws FingerprintMismatchError for a different payload on a completed key', async () => {
    const store = new InMemoryIdempotencyStore();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const handler = vi.fn().mockResolvedValue({ responseCode: 201, responseBody: {} });
    const baseInput = {
      store,
      clock,
      scope: SCOPE,
      key: 'k1',
      route: ROUTE,
      ttlMs: 3_600_000,
      lockDurationMs: 60_000,
      handler,
    };

    await runIdempotent({
      ...baseInput,
      metrics: new RecordingMetrics(),
      payload: { amount: 100 },
    });

    const metrics = new RecordingMetrics();
    await expect(
      runIdempotent({ ...baseInput, metrics, payload: { amount: 200 } }),
    ).rejects.toThrow(FingerprintMismatchError);
    expect(metrics.outcomes.map((o) => o.outcome)).toEqual(['fingerprint_mismatch']);
  });

  it('throws ConflictInProgressError with a positive retryAfterMs while still locked', async () => {
    const store = new InMemoryIdempotencyStore();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    // First call never resolves its handler, so the record stays "processing".
    const stuckHandler = () =>
      new Promise<{ responseCode: number; responseBody: null }>(() => undefined);
    void runIdempotent({
      store,
      metrics: new RecordingMetrics(),
      clock,
      scope: SCOPE,
      key: 'k1',
      route: ROUTE,
      payload: { amount: 100 },
      ttlMs: 3_600_000,
      lockDurationMs: 60_000,
      handler: stuckHandler,
    });

    const metrics = new RecordingMetrics();
    await expect(
      runIdempotent({
        store,
        metrics,
        clock,
        scope: SCOPE,
        key: 'k1',
        route: ROUTE,
        payload: { amount: 100 },
        ttlMs: 3_600_000,
        lockDurationMs: 60_000,
        handler: vi.fn(),
      }),
    ).rejects.toThrow(ConflictInProgressError);
    expect(metrics.outcomes).toEqual([{ outcome: 'conflict', attrs: { route: ROUTE } }]);
  });

  it('reclaims an expired lock and runs the handler again', async () => {
    const store = new InMemoryIdempotencyStore();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const stuckHandler = () =>
      new Promise<{ responseCode: number; responseBody: null }>(() => undefined);
    void runIdempotent({
      store,
      metrics: new RecordingMetrics(),
      clock,
      scope: SCOPE,
      key: 'k1',
      route: ROUTE,
      payload: { amount: 100 },
      ttlMs: 3_600_000,
      lockDurationMs: 1000,
      handler: stuckHandler,
    });

    clock.advanceMs(5000); // well past the 1s lock
    const metrics = new RecordingMetrics();
    const handler = vi.fn().mockResolvedValue({ responseCode: 201, responseBody: { id: 'retry' } });
    const result = await runIdempotent({
      store,
      metrics,
      clock,
      scope: SCOPE,
      key: 'k1',
      route: ROUTE,
      payload: { amount: 100 },
      ttlMs: 3_600_000,
      lockDurationMs: 1000,
      handler,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ replayed: false, responseCode: 201, responseBody: { id: 'retry' } });
    expect(metrics.outcomes.map((o) => o.outcome)).toEqual(['reclaimed']);
  });

  it('propagates a handler error and leaves the record processing, not completed', async () => {
    const store = new InMemoryIdempotencyStore();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const metrics = new RecordingMetrics();
    const boom = new Error('business logic failed');
    const handler = vi.fn().mockRejectedValue(boom);

    await expect(
      runIdempotent({
        store,
        metrics,
        clock,
        scope: SCOPE,
        key: 'k1',
        route: ROUTE,
        payload: { amount: 100 },
        ttlMs: 3_600_000,
        lockDurationMs: 60_000,
        handler,
      }),
    ).rejects.toThrow(boom);

    const record = await store.findForUpdate({ scope: SCOPE, key: 'k1' });
    expect(record?.status).toBe('processing');
    expect(metrics.processingStarted).toBe(1);
    expect(metrics.processingEnded).toBe(1);
    expect(metrics.durations).toEqual([{ seconds: 0, outcome: 'error' }]);
  });
});
