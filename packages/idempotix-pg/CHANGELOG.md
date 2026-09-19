# @sabeesoft/idempotix-pg

## 0.1.0

### Minor Changes

- 3362a50: First release. Shared PostgreSQL support for adapters: the idempotency SQL (`INSERT ... ON CONFLICT DO UPDATE` acquire-or-reclaim, `SELECT ... FOR UPDATE`, jsonb-safe completion, purge), row mapping, and `instrumentPgPool()` for OpenTelemetry `db.client.connection.*` metrics.

### Patch Changes

- Updated dependencies [3362a50]
  - @sabeesoft/idempotix-core@0.1.0
