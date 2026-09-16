import assert from 'node:assert/strict';
import {
  ConflictInProgressError,
  FingerprintMismatchError,
  NoopMetrics,
  runIdempotent,
  type Clock,
  type IdempotencyStore,
  type JsonValue,
} from '@sabeesoft/idempotix-core';

type TestFn = () => Promise<void> | void;

/**
 * The minimal slice of a test runner the contract suite needs. Jest, Vitest
 * and `node:test` all satisfy this shape structurally, so the suite has no
 * runner dependency of its own.
 */
export interface TestRunner {
  describe: (name: string, fn: () => void) => void;
  it: {
    (name: string, fn: TestFn): void;
    skip: (name: string, fn: TestFn) => void;
  };
  beforeEach: (fn: TestFn) => void;
  afterEach: (fn: TestFn) => void;
}

export interface StoreContractOptions {
  runner: TestRunner;
  /** Called before every test; must return an empty store. */
  createStore: () => Promise<IdempotencyStore> | IdempotencyStore;
  /** Optional per-test teardown (e.g. truncate the table). */
  cleanup?: (store: IdempotencyStore) => Promise<void> | void;
  /**
   * Optional. Runs `fn` inside a DB transaction that is rolled back when `fn`
   * throws. Enables the rollback scenario; omit it for non-transactional stores
   * and that scenario is reported as skipped.
   */
  runInTransaction?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const SCOPE = `acme${String.fromCharCode(31)}POST /payments/:id`;
const OTHER_SCOPE = `globex${String.fromCharCode(31)}POST /payments/:id`;
const KEY = 'idempotency-key-1';
const LOCK_MS = 60_000;
const TTL_MS = 3_600_000;

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

class SettableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  set(date: Date): void {
    this.current = date;
  }
}

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

/** A promise the test opens by hand, to hold a handler mid-flight. */
function gate(): Gate {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Registers the shared `IdempotencyStore` contract against one store
 * implementation. Every adapter (Prisma, TypeORM, in-memory, third-party)
 * must pass this suite unchanged.
 */
export function runStoreContractSuite(name: string, options: StoreContractOptions): void {
  const { runner, createStore, cleanup, runInTransaction } = options;
  const { describe, it, beforeEach, afterEach } = runner;

  describe(`IdempotencyStore contract: ${name}`, () => {
    let store: IdempotencyStore;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      await cleanup?.(store);
    });

    const acquire = (overrides: Partial<Parameters<IdempotencyStore['tryAcquire']>[0]> = {}) =>
      store.tryAcquire({
        scope: SCOPE,
        key: KEY,
        requestHash: 'hash-a',
        now: T0,
        lockDurationMs: LOCK_MS,
        ...overrides,
      });

    describe('store methods', () => {
      it('acquires a fresh key', async () => {
        assert.deepEqual(await acquire(), { outcome: 'acquired', reclaimed: false });
      });

      it('reports a conflict for a second acquire on the same scope+key', async () => {
        await acquire();
        assert.deepEqual(await acquire({ requestHash: 'hash-b', now: at(1000) }), {
          outcome: 'conflict',
        });
      });

      it('lets exactly one of many concurrent acquires win', async () => {
        const results = await Promise.all(Array.from({ length: 10 }, () => acquire()));
        const acquired = results.filter((r) => r.outcome === 'acquired');
        assert.equal(acquired.length, 1);
        assert.equal(results.length - acquired.length, 9);
      });

      it('treats the same key in different scopes as independent', async () => {
        assert.equal((await acquire()).outcome, 'acquired');
        assert.equal((await acquire({ scope: OTHER_SCOPE })).outcome, 'acquired');
      });

      it('findForUpdate returns null for an unknown key', async () => {
        assert.equal(await store.findForUpdate({ scope: SCOPE, key: 'unknown' }), null);
      });

      it('findForUpdate returns a processing record after acquire', async () => {
        await acquire();
        const record = await store.findForUpdate({ scope: SCOPE, key: KEY });
        assert.ok(record);
        assert.equal(record.scope, SCOPE);
        assert.equal(record.key, KEY);
        assert.equal(record.status, 'processing');
        assert.equal(record.requestHash, 'hash-a');
        assert.equal(record.responseCode, null);
        assert.equal(record.responseBody, null);
        assert.equal(record.lockedUntil.getTime(), at(LOCK_MS).getTime());
      });

      it('markCompleted stores the response and extends lockedUntil by the TTL', async () => {
        await acquire();
        const body: JsonValue = { id: 'p1', items: [1, 2], nested: { ok: true } };
        await store.markCompleted({
          scope: SCOPE,
          key: KEY,
          responseCode: 201,
          responseBody: body,
          now: at(500),
          ttlMs: TTL_MS,
        });
        const record = await store.findForUpdate({ scope: SCOPE, key: KEY });
        assert.ok(record);
        assert.equal(record.status, 'completed');
        assert.equal(record.responseCode, 201);
        assert.deepEqual(record.responseBody, body);
        assert.equal(record.lockedUntil.getTime(), at(500 + TTL_MS).getTime());
      });

      it('markCompleted round-trips a JSON null response body', async () => {
        await acquire();
        await store.markCompleted({
          scope: SCOPE,
          key: KEY,
          responseCode: 204,
          responseBody: null,
          now: T0,
          ttlMs: TTL_MS,
        });
        const record = await store.findForUpdate({ scope: SCOPE, key: KEY });
        assert.ok(record);
        assert.equal(record.status, 'completed');
        assert.equal(record.responseCode, 204);
        assert.equal(record.responseBody, null);
      });

      it('never reclaims a completed key, even after its TTL', async () => {
        await acquire();
        await store.markCompleted({
          scope: SCOPE,
          key: KEY,
          responseCode: 200,
          responseBody: {},
          now: T0,
          ttlMs: 1000,
        });
        assert.deepEqual(await acquire({ requestHash: 'hash-b', now: at(10_000) }), {
          outcome: 'conflict',
        });
      });

      it('reclaims a processing key whose lock has expired', async () => {
        await acquire({ lockDurationMs: 1000 });
        assert.deepEqual(await acquire({ requestHash: 'hash-b', now: at(5000) }), {
          outcome: 'acquired',
          reclaimed: true,
        });
        const record = await store.findForUpdate({ scope: SCOPE, key: KEY });
        assert.ok(record);
        assert.equal(record.status, 'processing');
        assert.equal(record.requestHash, 'hash-b');
        assert.equal(record.lockedUntil.getTime(), at(5000 + LOCK_MS).getTime());
      });

      it('does not reclaim a processing key inside its lock window', async () => {
        await acquire();
        assert.deepEqual(await acquire({ requestHash: 'hash-b', now: at(LOCK_MS - 1) }), {
          outcome: 'conflict',
        });
      });

      it('purgeExpired removes only rows whose lockedUntil has passed', async () => {
        await acquire({ key: 'live-processing', lockDurationMs: LOCK_MS });
        await acquire({ key: 'expired-processing', lockDurationMs: 1 });
        await acquire({ key: 'expired-completed' });
        await store.markCompleted({
          scope: SCOPE,
          key: 'expired-completed',
          responseCode: 200,
          responseBody: null,
          now: T0,
          ttlMs: 1,
        });
        await acquire({ key: 'live-completed' });
        await store.markCompleted({
          scope: SCOPE,
          key: 'live-completed',
          responseCode: 200,
          responseBody: null,
          now: T0,
          ttlMs: TTL_MS,
        });

        assert.equal(await store.purgeExpired({ now: at(100) }), 2);
        assert.ok(await store.findForUpdate({ scope: SCOPE, key: 'live-processing' }));
        assert.equal(await store.findForUpdate({ scope: SCOPE, key: 'expired-processing' }), null);
        assert.equal(await store.findForUpdate({ scope: SCOPE, key: 'expired-completed' }), null);
        assert.ok(await store.findForUpdate({ scope: SCOPE, key: 'live-completed' }));
      });
    });

    describe('orchestration (runIdempotent)', () => {
      const run = (
        clock: Clock,
        payload: unknown,
        handler: () => Promise<{ responseCode: number; responseBody: JsonValue }>,
        lockDurationMs = LOCK_MS,
      ) =>
        runIdempotent({
          store,
          metrics: new NoopMetrics(),
          clock,
          scope: SCOPE,
          key: KEY,
          route: 'POST /payments/:id',
          payload,
          ttlMs: TTL_MS,
          lockDurationMs,
          handler,
        });

      it('replays an identical request without re-running the handler', async () => {
        const clock = new SettableClock(T0);
        let calls = 0;
        const handler = () => {
          calls += 1;
          return Promise.resolve({ responseCode: 201, responseBody: { id: 'p1' } });
        };

        const first = await run(clock, { amount: 100 }, handler);
        const second = await run(clock, { amount: 100 }, handler);

        assert.equal(calls, 1);
        assert.deepEqual(first, { replayed: false, responseCode: 201, responseBody: { id: 'p1' } });
        assert.deepEqual(second, { replayed: true, responseCode: 201, responseBody: { id: 'p1' } });
      });

      it('rejects a different payload on a completed key with FingerprintMismatchError', async () => {
        const clock = new SettableClock(T0);
        const handler = () => Promise.resolve({ responseCode: 201, responseBody: {} });
        await run(clock, { amount: 100 }, handler);
        await assert.rejects(run(clock, { amount: 200 }, handler), FingerprintMismatchError);
      });

      it('rejects a concurrent call while the first is still processing with ConflictInProgressError', async () => {
        const clock = new SettableClock(T0);
        const release = gate();
        const entered = gate();
        const first = run(clock, { amount: 100 }, async () => {
          entered.resolve();
          await release.promise;
          return { responseCode: 201, responseBody: {} };
        });
        // Only once the handler has been entered is the key guaranteed to be acquired.
        await entered.promise;

        await assert.rejects(
          run(clock, { amount: 100 }, () =>
            Promise.resolve({ responseCode: 201, responseBody: {} }),
          ),
          (err: unknown) => err instanceof ConflictInProgressError && err.retryAfterMs > 0,
        );

        release.resolve();
        await first;
      });

      it('reclaims an expired lock and runs the handler again', async () => {
        const clock = new SettableClock(T0);
        const release = gate();
        const entered = gate();
        const stuck = run(
          clock,
          { amount: 100 },
          async () => {
            entered.resolve();
            await release.promise;
            return { responseCode: 500, responseBody: null };
          },
          1000,
        );
        await entered.promise;

        clock.set(at(5000));
        let calls = 0;
        const result = await run(
          clock,
          { amount: 100 },
          () => {
            calls += 1;
            return Promise.resolve({ responseCode: 201, responseBody: { id: 'retry' } });
          },
          1000,
        );

        assert.equal(calls, 1);
        assert.deepEqual(result, {
          replayed: false,
          responseCode: 201,
          responseBody: { id: 'retry' },
        });

        release.resolve();
        await stuck;
      });

      it('propagates a handler error, keeps the key processing, and allows a retry after the lock expires', async () => {
        const clock = new SettableClock(T0);
        const boom = new Error('business failure');
        await assert.rejects(
          run(clock, { amount: 100 }, () => Promise.reject(boom), 1000),
          (err: unknown) => err === boom,
        );

        const record = await store.findForUpdate({ scope: SCOPE, key: KEY });
        assert.ok(record);
        assert.equal(record.status, 'processing');

        clock.set(at(5000));
        const retry = await run(
          clock,
          { amount: 100 },
          () => Promise.resolve({ responseCode: 201, responseBody: { id: 'ok' } }),
          1000,
        );
        assert.deepEqual(retry, { replayed: false, responseCode: 201, responseBody: { id: 'ok' } });
      });

      const rollbackTest = runInTransaction ? it : it.skip;
      rollbackTest('rolls the key back when the handler fails inside a transaction', async () => {
        assert.ok(runInTransaction);
        const clock = new SettableClock(T0);
        const boom = new Error('business failure');
        await assert.rejects(
          runInTransaction(() => run(clock, { amount: 100 }, () => Promise.reject(boom))),
          (err: unknown) => err === boom,
        );
        assert.equal(await store.findForUpdate({ scope: SCOPE, key: KEY }), null);
      });
    });
  });
}
