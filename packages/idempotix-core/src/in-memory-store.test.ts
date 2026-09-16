import { describe, expect, it } from 'vitest';
import { InMemoryIdempotencyStore } from './in-memory-store.js';

const SCOPE = 'acmePOST /payments/:id';
const KEY = 'idem-key-1';

describe('InMemoryIdempotencyStore', () => {
  it('acquires a fresh key', async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await store.tryAcquire({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-a',
      now: new Date('2026-01-01T00:00:00Z'),
      lockDurationMs: 60_000,
    });
    expect(result).toEqual({ outcome: 'acquired', reclaimed: false });
  });

  it('reports a conflict for a second acquire on the same scope+key', async () => {
    const store = new InMemoryIdempotencyStore();
    const now = new Date('2026-01-01T00:00:00Z');
    await store.tryAcquire({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-a',
      now,
      lockDurationMs: 60_000,
    });
    const second = await store.tryAcquire({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-a',
      now,
      lockDurationMs: 60_000,
    });
    expect(second).toEqual({ outcome: 'conflict' });
  });

  it('findForUpdate returns the current row', async () => {
    const store = new InMemoryIdempotencyStore();
    const now = new Date('2026-01-01T00:00:00Z');
    await store.tryAcquire({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-a',
      now,
      lockDurationMs: 60_000,
    });
    const record = await store.findForUpdate({ scope: SCOPE, key: KEY });
    expect(record).toMatchObject({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-a',
      status: 'processing',
    });
  });

  it('findForUpdate returns null for an unknown key', async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.findForUpdate({ scope: SCOPE, key: 'nope' })).toBeNull();
  });

  it('markCompleted moves status to completed and extends lockedUntil by the TTL', async () => {
    const store = new InMemoryIdempotencyStore();
    const now = new Date('2026-01-01T00:00:00Z');
    await store.tryAcquire({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-a',
      now,
      lockDurationMs: 60_000,
    });
    await store.markCompleted({
      scope: SCOPE,
      key: KEY,
      responseCode: 201,
      responseBody: { id: 'abc' },
      now,
      ttlMs: 3_600_000,
    });
    const record = await store.findForUpdate({ scope: SCOPE, key: KEY });
    expect(record).toMatchObject({
      status: 'completed',
      responseCode: 201,
      responseBody: { id: 'abc' },
      lockedUntil: new Date(now.getTime() + 3_600_000),
    });
  });

  it('markCompleted throws for a record that does not exist', async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(
      store.markCompleted({
        scope: SCOPE,
        key: 'nope',
        responseCode: 200,
        responseBody: null,
        now: new Date(),
        ttlMs: 1000,
      }),
    ).rejects.toThrow();
  });

  it('reclaims an expired-while-processing row instead of reporting a conflict', async () => {
    const store = new InMemoryIdempotencyStore();
    const acquiredAt = new Date('2026-01-01T00:00:00Z');
    await store.tryAcquire({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-a',
      now: acquiredAt,
      lockDurationMs: 1000,
    });

    const retryAt = new Date(acquiredAt.getTime() + 5000); // well past the 1s lock
    const result = await store.tryAcquire({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-b',
      now: retryAt,
      lockDurationMs: 1000,
    });

    expect(result).toEqual({ outcome: 'acquired', reclaimed: true });
    const record = await store.findForUpdate({ scope: SCOPE, key: KEY });
    expect(record).toMatchObject({ requestHash: 'hash-b', status: 'processing' });
  });

  it('does not reclaim a still-locked processing row', async () => {
    const store = new InMemoryIdempotencyStore();
    const acquiredAt = new Date('2026-01-01T00:00:00Z');
    await store.tryAcquire({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-a',
      now: acquiredAt,
      lockDurationMs: 60_000,
    });

    const retryAt = new Date(acquiredAt.getTime() + 1000); // well within the 60s lock
    const result = await store.tryAcquire({
      scope: SCOPE,
      key: KEY,
      requestHash: 'hash-b',
      now: retryAt,
      lockDurationMs: 60_000,
    });

    expect(result).toEqual({ outcome: 'conflict' });
  });

  it('purgeExpired removes only rows whose lockedUntil has passed, regardless of status', async () => {
    const store = new InMemoryIdempotencyStore();
    const now = new Date('2026-01-01T00:00:00Z');

    // Still-locked processing row — must survive.
    await store.tryAcquire({
      scope: SCOPE,
      key: 'still-processing',
      requestHash: 'h',
      now,
      lockDurationMs: 60_000,
    });

    // Expired processing row — must be purged.
    await store.tryAcquire({
      scope: SCOPE,
      key: 'expired-processing',
      requestHash: 'h',
      now,
      lockDurationMs: 1,
    });

    // Completed but expired row — must be purged.
    await store.tryAcquire({
      scope: SCOPE,
      key: 'expired-completed',
      requestHash: 'h',
      now,
      lockDurationMs: 60_000,
    });
    await store.markCompleted({
      scope: SCOPE,
      key: 'expired-completed',
      responseCode: 200,
      responseBody: null,
      now,
      ttlMs: 1,
    });

    // Completed and still within TTL — must survive.
    await store.tryAcquire({
      scope: SCOPE,
      key: 'fresh-completed',
      requestHash: 'h',
      now,
      lockDurationMs: 60_000,
    });
    await store.markCompleted({
      scope: SCOPE,
      key: 'fresh-completed',
      responseCode: 200,
      responseBody: null,
      now,
      ttlMs: 3_600_000,
    });

    const sweepAt = new Date(now.getTime() + 100);
    const purged = await store.purgeExpired({ now: sweepAt });

    expect(purged).toBe(2);
    expect(await store.findForUpdate({ scope: SCOPE, key: 'still-processing' })).not.toBeNull();
    expect(await store.findForUpdate({ scope: SCOPE, key: 'expired-processing' })).toBeNull();
    expect(await store.findForUpdate({ scope: SCOPE, key: 'expired-completed' })).toBeNull();
    expect(await store.findForUpdate({ scope: SCOPE, key: 'fresh-completed' })).not.toBeNull();
  });
});
