# Example: NestJS + Prisma + idempotix

A small payments API showing the recommended stack end to end: NestJS 12, Prisma 7 (`@prisma/adapter-pg`), `@nestjs-cls/transactional`, `IdempotixModule` with the Prisma store, `instrumentPrisma()` for pool/query metrics, and an OpenTelemetry `NodeSDK` exposing Prometheus metrics on `:9464`.

## Run it

```bash
# from the repo root
pnpm install && pnpm build

cd examples/nestjs-prisma
docker compose up -d          # or, without docker-compose: podman run -d --name idempotix-pg \
                              #   -e POSTGRES_USER=idempotix -e POSTGRES_PASSWORD=idempotix -e POSTGRES_DB=idempotix \
                              #   -p 5432:5432 docker.io/library/postgres:17-alpine
pnpm generate                 # Prisma client into src/generated
pnpm db:push                  # creates accounts, payments, idempotency_keys
pnpm dev                      # tsc build + node dist/main.js; api on :3000, metrics on :9464
```

## Walk through it

```bash
# an account to pay into
curl -s -X POST localhost:3000/accounts/acc-1

# 1. first call: handler runs, 201
curl -si -X POST localhost:3000/accounts/acc-1/payments \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k1' \
  -d '{"amount": 100}'

# 2. same key, same payload: replayed, handler did NOT run again
curl -si -X POST localhost:3000/accounts/acc-1/payments \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k1' \
  -d '{"amount": 100}'
#   HTTP/1.1 201 Created
#   Idempotent-Replayed: true

# 3. same key, different payload: 422
curl -si -X POST localhost:3000/accounts/acc-1/payments \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k1' \
  -d '{"amount": 200}'

# 4. still processing: start a slow one, duplicate it while it runs
curl -s -X POST localhost:3000/accounts/acc-1/payments \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k2' \
  -d '{"amount": 5, "delayMs": 3000}' &
sleep 0.5
curl -si -X POST localhost:3000/accounts/acc-1/payments \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k2' \
  -d '{"amount": 5, "delayMs": 3000}'
#   Either a replay (Postgres held the duplicate on the row lock until the first
#   committed) or, if the lock could not be waited for, 409 with Retry-After.

# 5. failure rolls everything back: no payment row, no key, balance unchanged
curl -si -X POST localhost:3000/accounts/acc-1/payments \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k3' \
  -d '{"amount": 7, "fail": true}'
curl -s localhost:3000/accounts/acc-1/payments      # k3's payment is not there
# ...and the same key can be retried:
curl -si -X POST localhost:3000/accounts/acc-1/payments \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: k3' \
  -d '{"amount": 7}'

# 6. explicit mode: two idempotent blocks in one transaction
curl -s -X POST localhost:3000/accounts/acc-2
curl -si -X POST localhost:3000/transfers \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: t1' \
  -d '{"from": "acc-1", "to": "acc-2", "amount": 30}'

# 7. metrics
curl -s localhost:9464/metrics | grep -E '^idempotix_|^db_client_'
```

Tenants: add `X-Tenant: <id>` to scope keys per tenant (the example's `tenant` option reads that header).

## Where to look

| File                          | What it shows                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/app.module.ts`           | the whole wiring: `ClsModule` + `TransactionalAdapterPrisma`, `IdempotixModule.forRootAsync` with `store` and `runInTransaction` |
| `src/database.ts`             | building the client with `@prisma/adapter-pg` and `instrumentPrisma()`                                                           |
| `src/payments.controller.ts`  | `@Idempotent()` on a handler that writes through `host.tx`                                                                       |
| `src/transfers.controller.ts` | `IdempotixService.run()` for several blocks inside one transaction                                                               |
| `src/telemetry.ts`            | the OTel SDK with a Prometheus reader                                                                                            |

The Prisma client is generated into `src/generated/` (gitignored) by `pnpm generate` (Turborepo runs it before build/lint/typecheck/test).
The example is compiled with `tsc` and run with plain `node` rather than `tsx`: `@nestjs/core` 12 is ESM-only while `nestjs-cls` is CommonJS, and under tsx's loader the CJS `require('@nestjs/core')` produced a second copy of the module, so `HttpAdapterHost` failed to resolve in `ClsRootModule`. Plain Node's `require(esm)` shares the instance.
