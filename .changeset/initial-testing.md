---
'@sabeesoft/idempotix-testing': minor
---

First release. `runStoreContractSuite()`: the runner-agnostic contract every `IdempotencyStore` must pass (concurrent duplicates, replay, fingerprint mismatch, in-progress conflict, lock reclaim, expiry, JSON-null bodies, and transaction rollback when a `runInTransaction` hook is supplied).
