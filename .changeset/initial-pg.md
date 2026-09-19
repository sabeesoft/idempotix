---
'@sabeesoft/idempotix-pg': minor
---

First release. Shared PostgreSQL support for adapters: the idempotency SQL (`INSERT ... ON CONFLICT DO UPDATE` acquire-or-reclaim, `SELECT ... FOR UPDATE`, jsonb-safe completion, purge), row mapping, and `instrumentPgPool()` for OpenTelemetry `db.client.connection.*` metrics.
