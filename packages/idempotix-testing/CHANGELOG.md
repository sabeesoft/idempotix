# @sabeesoft/idempotix-testing

## 0.1.0

### Minor Changes

- 3362a50: First release. `runStoreContractSuite()`: the runner-agnostic contract every `IdempotencyStore` must pass (concurrent duplicates, replay, fingerprint mismatch, in-progress conflict, lock reclaim, expiry, JSON-null bodies, and transaction rollback when a `runInTransaction` hook is supplied).

### Patch Changes

- Updated dependencies [3362a50]
  - @sabeesoft/idempotix-core@0.1.0
