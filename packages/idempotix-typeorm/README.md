# @sabeesoft/idempotix-typeorm

TypeORM (1.x) / PostgreSQL store adapter for [idempotix](../../README.md). The idempotency record is written through **your** `EntityManager` — inside your transaction when you hand the store the transaction's manager — so the record and your business write commit or roll back together.

## Install

```bash
pnpm add @sabeesoft/idempotix-core @sabeesoft/idempotix-typeorm
```

`typeorm` (1.x) and `@opentelemetry/api` are peer dependencies. The store talks to Postgres through `EntityManager.query()` with bound parameters and does not depend on the entity below.

## 1. Add the table

Either register the shipped entity (`entities: [IdempotencyKeyEntity]`) and let TypeORM migrations / `synchronize` create the table, or apply [`migration.sql`](migration.sql) with your own tooling. Nothing is applied automatically. The entity declares every column type explicitly, so it works without `emitDecoratorMetadata`.

## 2. Create the store

```ts
import { createTypeormIdempotencyStore } from '@sabeesoft/idempotix-typeorm';

// Non-transactional: every store call uses the data source's manager.
const store = createTypeormIdempotencyStore({ manager: () => dataSource.manager });

// Joining the application's transaction: return whatever transaction manager is
// active for the current request. With @nestjs-cls/transactional that is
// `() => transactionHost.tx`.
const store = createTypeormIdempotencyStore({
  manager: () => transactionHost.tx,
  tableName: 'app.idempotency_keys', // optional, default "idempotency_keys"
});
```

With NestJS:

```ts
ClsModule.forRoot({
  middleware: { mount: true },
  plugins: [
    new ClsPluginTransactional({
      imports: [DatabaseModule],
      adapter: new TransactionalAdapterTypeOrm({ dataSourceToken: DataSource }),
    }),
  ]),
IdempotixModule.forRootAsync({
  inject: [TransactionHost],
  useFactory: (host: TransactionHost<TransactionalAdapterTypeOrm>) => ({
    store: createTypeormIdempotencyStore({ manager: () => host.tx }),
    runInTransaction: (fn) => host.withTransaction(fn),
  }),
}),
```

The SQL is the same as the Prisma adapter's (both come from `@sabeesoft/idempotix-pg`): one `INSERT … ON CONFLICT DO UPDATE … WHERE` that acquires or reclaims, `SELECT … FOR UPDATE`, a `jsonb` body that keeps JSON `null` distinct from SQL `NULL`, and a validated, quoted table name as the only interpolated identifier.

## Metrics: `instrumentTypeorm()`

Standalone OpenTelemetry instrumentation for a TypeORM + Postgres `DataSource`; call it after `initialize()`:

```ts
const { dispose } = instrumentTypeorm({ dataSource, poolName: 'primary' });
```

| Metric                                                                                                      | Type                          | Attributes                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db.client.operation.duration`                                                                              | histogram `s`                 | `db.system.name=postgresql`, `db.operation.name` (the statement's leading keyword: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `WITH`, `START`, `COMMIT`, `ROLLBACK`, … or `OTHER`), `error.type` (Postgres error code) on failure |
| `db.client.connection.{count,max,pending_requests,wait_time,use_time,timeouts}`, `idempotix.db.pool.errors` | see `@sabeesoft/idempotix-pg` | pool name                                                                                                                                                                                                                      |

Query durations come from TypeORM's own `afterQuery` subscriber event — nothing is patched. `db.collection.name` is deliberately not set: TypeORM only exposes the SQL text, and extracting table names from it is neither reliable nor safe for metric cardinality. Query text and parameters never become attributes. `queries: false` / `pool: false` switch either group off.

## Expired rows

```sql
DELETE FROM idempotency_keys WHERE locked_until < now();
```

Run it from a scheduled job; the store never deletes rows on its own.

## Running this package's tests

Same as `@sabeesoft/idempotix-prisma`: a Docker-compatible runtime for Testcontainers (rootless podman works with `docker.host=unix:///run/user/1000/podman/podman.sock` in `~/.testcontainers.properties`). Without one the Postgres suites are reported as skipped.
