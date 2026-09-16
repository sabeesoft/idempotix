# @sabeesoft/idempotix-nestjs

NestJS integration for [idempotix](../../README.md): one module registration and one decorator make an endpoint idempotent, with the idempotency record written inside your application's own database transaction.

## Install

```bash
pnpm add @sabeesoft/idempotix-core @sabeesoft/idempotix-nestjs @sabeesoft/idempotix-prisma
```

Peer dependencies: `@nestjs/common`, `@nestjs/core` (11 or 12), `reflect-metadata`, `rxjs`. No dependency on any ORM or on `nestjs-cls` — those stay under your control.

## Wiring with `@nestjs-cls/transactional` (recommended)

```ts
import { ClsModule } from 'nestjs-cls';
import { ClsPluginTransactional, TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { IdempotixModule } from '@sabeesoft/idempotix-nestjs';
import { createPrismaIdempotencyStore } from '@sabeesoft/idempotix-prisma';

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
        ttl: '24h',
      }),
    }),
  ],
})
export class AppModule {}
```

`runInTransaction` wraps the guarded handler: `withTransaction` joins an already-active transaction or opens one, so the idempotency record and everything the handler writes through `host.tx` commit — or roll back — together. Interactive-transaction `timeout`/`maxWait` are configured on the adapter's `defaultTxOptions`.

Any other transaction manager works the same way: give `runInTransaction` a function that runs its argument inside a transaction and rethrows on failure, and give the store a `client` callback that returns the transaction's client.

## Decorating a route

```ts
@Post()
@Idempotent()                      // or @Idempotent({ ttl: '1h', lockTtl: '30s', route: 'payments.create' })
createPayment(@Body() dto: CreatePaymentDto) { ... }
```

Behaviour for a request carrying an `Idempotency-Key` header:

| Situation                                                        | Response                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| First time this key is seen                                      | handler runs; response stored                                                                          |
| Same key, same payload, completed                                | stored response replayed, `Idempotent-Replayed: true`                                                  |
| Same key, different payload (`params`, `query` or `body` differ) | `422 Unprocessable Entity`                                                                             |
| Same key, still processing                                       | `409 Conflict` with `Retry-After` (seconds)                                                            |
| Handler throws                                                   | error propagates unchanged; the transaction rolls back and the key disappears, so the client can retry |

The key is scoped by tenant (see `tenant` below) and the route template (`POST /payments/:id`), never the resolved URL.

## Options

| Option             | Default             | Notes                                                                                                                                                            |
| ------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store`            | —                   | required; e.g. `createPrismaIdempotencyStore(...)`                                                                                                               |
| `ttl`              | `'24h'`             | how long a completed response is replayable                                                                                                                      |
| `lockTtl`          | `'60s'`             | how long an abandoned `processing` key blocks retries before it is reclaimed; keep it above your longest handler + transaction timeout                           |
| `keyHeader`        | `'Idempotency-Key'` | header read case-insensitively                                                                                                                                   |
| `keyExtractor`     | header lookup       | `(request) => string \| undefined`; replaces the header lookup                                                                                                   |
| `onMissingKey`     | `'generate'`        | `'generate'` runs the request with a fresh random key (no protection against a retry — reported as the `key_generated` metric outcome); `'reject'` answers `400` |
| `tenant`           | none                | `(request) => string \| null`; isolates keys per client/tenant                                                                                                   |
| `runInTransaction` | pass-through        | see above                                                                                                                                                        |
| `metrics`, `clock` | no-op, system clock | see `@sabeesoft/idempotix-core`                                                                                                                                  |

Options are validated at startup; a bad value throws `IdempotixConfigurationError` naming the option.

## Explicit mode: `IdempotixService`

For flows that own their transaction boundary, need several idempotent blocks in one request, or must keep a long-running external call outside the guarded section:

```ts
constructor(private readonly idempotix: IdempotixService) {}

async settle(key: string, order: Order) {
  const quote = await this.fxProvider.quote(order);          // outside any transaction

  const debit = await this.idempotix.run({
    key: `${key}:debit`,
    route: 'ledger.debit',                                   // low-cardinality operation name
    payload: { orderId: order.id, amount: order.amount },
    handler: () => this.ledger.debit(order, quote),
  });
  const credit = await this.idempotix.run({
    key: `${key}:credit`,
    route: 'ledger.credit',
    payload: { orderId: order.id, amount: order.amount },
    handler: () => this.ledger.credit(order, quote),
  });
  return { debit: debit.value, credit: credit.value };
}
```

`run()` returns `{ replayed, value }` and throws `FingerprintMismatchError` / `ConflictInProgressError` from `@sabeesoft/idempotix-core` (map them yourself if they must become HTTP responses). It never opens a transaction: keep the acquire and the business write inside one transaction of your own (`@Transactional()` on the method, for instance). If you commit a `processing` record before completing it, a reclaim after `lockTtl` can race the original writer.

## Known limitations

- Replays re-use the route's static status (`@HttpCode()` or Nest's 201/200 default). A status set dynamically through `@Res()` is not replayed.
- Only the HTTP context is intercepted; other transport contexts pass through untouched.
- The stored response is the handler's return value serialised as JSON — the same thing the client received. Streams and non-JSON bodies are not supported. A replayed body is structurally identical to the original, but object key order may differ (PostgreSQL `jsonb` does not preserve it), so clients must not compare raw response bytes.
