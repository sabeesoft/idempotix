# idempotix

Banking-grade idempotency for NestJS endpoints — with the idempotency record written **inside your own database transaction**, and OpenTelemetry metrics for what it does to your database.

![CI](https://github.com/sabeesoft/idempotix/actions/workflows/ci.yml/badge.svg)

## What it guarantees

1. **One transaction.** The idempotency record and your business write commit or roll back together, through the Prisma client or TypeORM `EntityManager` your app already uses. No separate pool, no Redis-only promises.
2. **A failed request leaves no trace.** If your handler throws, the transaction rolls back and the key disappears, so the client can retry.
3. **Duplicates are replayed, not re-executed.** Same key + same payload → the stored response, with `Idempotent-Replayed: true`.
4. **Reuse is rejected.** Same key + different payload → `422`. Same key still in flight → `409` with `Retry-After` — or, on PostgreSQL, the duplicate waits on the row lock and gets the replay.
5. **Keys are scoped** by tenant and route template; the same key on two routes or two tenants are two keys.
6. **Metrics never leak identifiers.** Attributes are route templates and bounded enums; the types have no slot for a key, request id or user id.

## Quick start (NestJS + Prisma)

```bash
pnpm add @sabeesoft/idempotix-core @sabeesoft/idempotix-nestjs @sabeesoft/idempotix-prisma
pnpm add nestjs-cls @nestjs-cls/transactional @nestjs-cls/transactional-adapter-prisma
```

1. Add the `IdempotencyKey` model from [`packages/idempotix-prisma/README.md`](packages/idempotix-prisma/README.md) to your schema and migrate.
2. Register the module — the store gets the request's transaction client, and every guarded handler runs inside `host.withTransaction`:

```ts
@Module({
  imports: [
    ClsModule.forRoot({
      middleware: { mount: true },
      plugins: [
        new ClsPluginTransactional({
          imports: [PrismaModule],
          adapter: new TransactionalAdapterPrisma({ prismaInjectionToken: PrismaService }),
        }),
      ],
    }),
    IdempotixModule.forRootAsync({
      inject: [TransactionHost],
      useFactory: (host: TransactionHost<TransactionalAdapterPrisma<PrismaClient>>) => ({
        store: createPrismaIdempotencyStore({ client: () => host.tx }),
        runInTransaction: (fn) => host.withTransaction(fn),
      }),
    }),
  ],
})
export class AppModule {}
```

3. Decorate a route:

```ts
@Post()
@Idempotent()
createPayment(@Body() dto: CreatePaymentDto) {
  return this.payments.create(dto); // writes through host.tx
}
```

That is the whole integration. [`examples/nestjs-prisma`](examples/nestjs-prisma) is a runnable version with a `curl` walkthrough; TypeORM differs by three lines ([`packages/idempotix-typeorm/README.md`](packages/idempotix-typeorm/README.md)).

## How a request flows

| The client sends `Idempotency-Key: k` and…          | idempotix does                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `k` was never seen                                  | acquires `k` in your transaction, runs the handler, stores the response, commits                                                                          |
| `k` completed with the same `params`/`query`/`body` | replays the stored status and body, `Idempotent-Replayed: true`; the handler does not run                                                                 |
| `k` completed with a different payload              | `422 Unprocessable Entity`                                                                                                                                |
| `k` is still being processed                        | `409 Conflict` + `Retry-After` (on Postgres a concurrent duplicate usually blocks on the row lock instead and replays once the first commits)             |
| the handler throws                                  | the error propagates, the transaction rolls back, `k` is gone                                                                                             |
| no key at all                                       | by default a random key is generated and the request runs **unprotected** (visible as the `key_generated` metric); `onMissingKey: 'reject'` answers `400` |

A crashed request whose transaction never committed leaves nothing behind. A `processing` record that _was_ committed (explicit mode, see below) blocks retries only until `lockTtl` (default 60 s) and is then reclaimed. Completed records are replayable for `ttl` (default 24 h) and are never reclaimed.

## Two modes

**Interceptor mode** (`@Idempotent()`): idempotix opens — or joins — the transaction through `runInTransaction` and runs the handler inside it. Use it for ordinary request handlers.

**Explicit mode** (`IdempotixService.run()`): you own the transaction boundary. Use it when a request needs several idempotent blocks, or must keep a long-running external call outside the guarded section (never hold a DB transaction open across a network call):

```ts
const quote = await this.fx.quote(order); // outside any transaction
await this.host.withTransaction(async () => {
  const debit = await this.idempotix.run({
    key: `${key}:debit`,
    route: 'ledger.debit',
    payload: order,
    handler: () => this.ledger.debit(order, quote),
  });
  const credit = await this.idempotix.run({
    key: `${key}:credit`,
    route: 'ledger.credit',
    payload: order,
    handler: () => this.ledger.credit(order, quote),
  });
});
```

Keep each block's acquire and business write in one transaction; committing a `processing` record early re-opens the window that `lockTtl` then bounds.

`runInTransaction` is a plain function `(fn) => Promise` — anything that runs `fn` in a transaction and rethrows on failure works, `@nestjs-cls/transactional` is just the recommended one.

## Configuration

| Option                       | Default           |                                                                                       |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| `store`                      | —                 | `createPrismaIdempotencyStore(...)` / `createTypeormIdempotencyStore(...)` / your own |
| `ttl`                        | `'24h'`           | replay window for completed keys                                                      |
| `lockTtl`                    | `'60s'`           | how long an abandoned `processing` key blocks retries                                 |
| `keyHeader` / `keyExtractor` | `Idempotency-Key` | where the key comes from                                                              |
| `onMissingKey`               | `'generate'`      | or `'reject'` (400)                                                                   |
| `tenant`                     | none              | `(request) => string \| null` — scopes keys per client/tenant                         |
| `runInTransaction`           | pass-through      | see above                                                                             |
| `metrics`                    | `'otel'`          | `'noop'` or a custom `IdempotencyMetrics`                                             |

Per route: `@Idempotent({ ttl, lockTtl, route })`. Options are validated at startup. Full reference: [`packages/idempotix-nestjs/README.md`](packages/idempotix-nestjs/README.md).

## Expired rows

The store never deletes. Run from a scheduled job:

```sql
DELETE FROM idempotency_keys WHERE locked_until < now();
```

## Metrics

On by default through `@opentelemetry/api`; a no-op until your app registers a `MeterProvider`. `idempotix.*` covers outcomes, in-flight keys, handler and transaction durations; `db.client.*` (OTel database semantic conventions) covers query durations and pool state via `instrumentPrisma()` / `instrumentTypeorm()` — both usable standalone, without the idempotency features. The catalogue, SDK bootstrap and a per-database dashboard (connections across all services vs `max_connections`) are in [`docs/observability.md`](docs/observability.md).

## Writing your own store adapter

1. Implement core's `IdempotencyStore` (`tryAcquire`, `findForUpdate`, `markCompleted`, `purgeExpired`). On PostgreSQL, `@sabeesoft/idempotix-pg` already has the SQL and row mapping — the TypeORM store is ~80 lines on top of it.
2. Resolve the client per call so the store follows the caller's current transaction.
3. Run `runStoreContractSuite` from `@sabeesoft/idempotix-testing` against it, with a `runInTransaction` hook so the rollback scenario runs too.

## Packages

| Package                                                      | Purpose                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [`@sabeesoft/idempotix-core`](packages/idempotix-core)       | state machine, fingerprinting, scoping, ports, in-memory store — zero dependencies |
| [`@sabeesoft/idempotix-nestjs`](packages/idempotix-nestjs)   | `IdempotixModule`, `@Idempotent()`, interceptor, `IdempotixService`, OTel metrics  |
| [`@sabeesoft/idempotix-prisma`](packages/idempotix-prisma)   | Prisma 7 / Postgres store, `instrumentPrisma()`                                    |
| [`@sabeesoft/idempotix-typeorm`](packages/idempotix-typeorm) | TypeORM 1.x / Postgres store, entity, `instrumentTypeorm()`                        |
| [`@sabeesoft/idempotix-pg`](packages/idempotix-pg)           | shared Postgres SQL + `pg.Pool` instrumentation for adapters                       |
| [`@sabeesoft/idempotix-testing`](packages/idempotix-testing) | the store contract suite (runner-agnostic)                                         |

Requirements: Node.js 24, NestJS 11 or 12, PostgreSQL. Packages are ESM + CJS with TypeScript types.

## Limitations and roadmap

- HTTP only for now. Message-consumer idempotency (inbox pattern), a transactional outbox, key propagation to downstream services, and further adapters (Kysely, Drizzle, MikroORM) are planned, not present.
- Replays reuse the route's static status code; a status set dynamically via `@Res()` is not replayed. Response bodies must be JSON; key order in a replayed body may differ (`jsonb`).
- Only PostgreSQL adapters exist; the store port is DB-agnostic, the shipped SQL is not.

## Development

```bash
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test   # DB suites need Docker or podman (see CLAUDE.md)
```

## License

[Apache-2.0](LICENSE)
