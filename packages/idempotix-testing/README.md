# @sabeesoft/idempotix-testing

The contract test suite every `IdempotencyStore` implementation must pass — the ones in this repo and yours. It is runner-agnostic: you hand it your test runner's `describe`/`it`/`beforeEach`/`afterEach` (Jest, Vitest and `node:test` all fit) and it asserts with `node:assert/strict`, so it has no peer dependency on any test framework.

```ts
import { runStoreContractSuite } from '@sabeesoft/idempotix-testing';
import { afterEach, beforeEach, describe, it } from 'vitest'; // or jest / node:test

runStoreContractSuite('MyStore', {
  runner: { describe, it, beforeEach, afterEach },
  createStore: () => new MyStore(db), // must return an empty store, called before every test
  cleanup: async () => db.query('TRUNCATE idempotency_keys'),
  runInTransaction: (fn) => db.transaction(fn), // optional, see below
});
```

## What it checks

Store methods: fresh acquire; conflict on a second acquire; exactly one winner among 10 concurrent acquires; scope isolation; `findForUpdate` for unknown, processing and completed keys; `markCompleted` round-trips an object body **and a JSON `null` body** (the case DB adapters most often get wrong — SQL `NULL` vs `'null'::jsonb`); completed keys are never reclaimed; expired processing locks are reclaimed with `reclaimed: true`; unexpired ones are not; `purgeExpired` removes only rows past `lockedUntil`.

Orchestration (`runIdempotent` against your store): replay without re-running the handler, `FingerprintMismatchError` on a changed payload, `ConflictInProgressError` while processing, reclaim after lock expiry, error propagation with a later retry, and — when `runInTransaction` is given — the rollback scenario: a handler that throws inside the transaction leaves no key behind.

## `runInTransaction`

Provide a function that runs its argument inside a database transaction and rolls back when it throws. Your store's client/manager callback must resolve to that transaction's client while `fn` runs (see the Prisma and TypeORM packages' test files for the "swap the current client" pattern). Without it the rollback scenario is reported as **skipped** — visibly, so a store that cannot participate in transactions cannot look fully compliant by accident.

Timing is never real: every store call receives an explicit `now`, so the suite is deterministic.
