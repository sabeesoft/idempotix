---
'@sabeesoft/idempotix-prisma': minor
---

First release. Prisma 7 / PostgreSQL store adapter that writes the idempotency record through the client you hand it — the request's transaction client, so record and business write commit or roll back together — plus `instrumentPrisma()` for query and pool metrics, a reference model and migration SQL.
