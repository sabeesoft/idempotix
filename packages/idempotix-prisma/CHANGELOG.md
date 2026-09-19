# @sabeesoft/idempotix-prisma

## 0.1.0

### Minor Changes

- 3362a50: First release. Prisma 7 / PostgreSQL store adapter that writes the idempotency record through the client you hand it — the request's transaction client, so record and business write commit or roll back together — plus `instrumentPrisma()` for query and pool metrics, a reference model and migration SQL.

### Patch Changes

- Updated dependencies [3362a50]
- Updated dependencies [3362a50]
  - @sabeesoft/idempotix-core@0.1.0
  - @sabeesoft/idempotix-pg@0.1.0
