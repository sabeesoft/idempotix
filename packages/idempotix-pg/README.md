# @sabeesoft/idempotix-pg

Shared PostgreSQL support for idempotix adapters. **Not an adapter itself** — `@sabeesoft/idempotix-prisma` and `@sabeesoft/idempotix-typeorm` build on it, and so can a Kysely/Drizzle/`pg`-native adapter of your own.

## What is in it

- `postgresIdempotencySql(tableName?)` — the four statements the adapters run (`acquire` = one `INSERT … ON CONFLICT DO UPDATE … WHERE` that inserts or reclaims an expired lock and returns `inserted`; `find` = `SELECT … FOR UPDATE`; `complete`; `purge`), with `$n` placeholders. `quoteTableName()` validates and quotes the only identifier ever interpolated.
- `toIdempotencyRecord(row)` — maps a raw row to core's `IdempotencyRecord`, using `status` to tell a real JSON `null` body from "not completed".
- `instrumentPgPool({ pool, poolName?, meterProvider? })` — OpenTelemetry `db.client.connection.*` metrics for any `pg.Pool` (count by state, max, pending requests, wait/use time, timeouts) plus `idempotix.db.pool.errors`. Usable on its own, without any idempotency feature:

```ts
import { instrumentPgPool } from '@sabeesoft/idempotix-pg';

const { dispose } = instrumentPgPool({ pool, poolName: 'primary' });
```

`pg` emits no "waiting" event, so wait time and timeouts are measured around the pool's `connect()`; `dispose()` restores it. Attribute values are the pool name, the connection state and error codes only.

## Writing an adapter on top of it

Resolve your ORM's client per call, run the statements through it, map rows with `toIdempotencyRecord`, and verify with `@sabeesoft/idempotix-testing`. The TypeORM store (`packages/idempotix-typeorm/src/store.ts`) is ~80 lines and a good template; the one thing to check is how your driver returns row counts for `UPDATE`/`DELETE`.
