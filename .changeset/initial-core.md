---
'@sabeesoft/idempotix-core': minor
---

First release. The framework- and ORM-agnostic core: `runIdempotent()` orchestration (acquire, replay, fingerprint-mismatch and in-progress conflict handling, lock reclaim), canonical-JSON SHA-256 fingerprinting, tenant + route scoping, TTL parsing, domain errors, the `IdempotencyStore` / `IdempotencyMetrics` / `Clock` ports, and an in-memory store. Zero runtime dependencies.
