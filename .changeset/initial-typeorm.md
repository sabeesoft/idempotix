---
'@sabeesoft/idempotix-typeorm': minor
---

First release. TypeORM 1.x / PostgreSQL store adapter driven through your own `EntityManager`, the reference entity and migration SQL, and `instrumentTypeorm()` which takes query metrics from TypeORM's `afterQuery` subscriber event and pool metrics from the driver's `pg.Pool`.
