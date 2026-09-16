# @sabeesoft/idempotix-prisma

Prisma 7 / PostgreSQL store adapter for [idempotix](../../README.md). The idempotency record is written through **your** Prisma client — inside your transaction when you hand the store the transaction client — so the record and your business write commit or roll back together.

## Install

```bash
pnpm add @sabeesoft/idempotix-core @sabeesoft/idempotix-prisma
```

`@prisma/client` (7.x) is a peer dependency: the adapter talks to Postgres through your own client's `$queryRawUnsafe` / `$executeRawUnsafe` and never imports `@prisma/client` itself.

## 1. Add the table

Copy the model into your `schema.prisma` (keep the `@map`/`@@map` names, or pass a different `tableName` below):

```prisma
model IdempotencyKey {
  scope        String
  key          String
  requestHash  String   @map("request_hash")
  status       String
  responseCode Int?     @map("response_code")
  responseBody Json?    @map("response_body")
  lockedUntil  DateTime @map("locked_until") @db.Timestamptz(3)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  @@id([scope, key])
  @@index([lockedUntil])
  @@map("idempotency_keys")
}
```

Then create a migration (`prisma migrate dev`), or apply [`prisma/migration.sql`](prisma/migration.sql) with your own tooling. Nothing is applied automatically.

## 2. Create the store

```ts
import { createPrismaIdempotencyStore } from '@sabeesoft/idempotix-prisma';

// Non-transactional: every store call uses the plain client.
const store = createPrismaIdempotencyStore({ client: () => prisma });

// Joining the application's transaction: return whatever transaction client is
// active for the current request. With @nestjs-cls/transactional that is
// `() => transactionHost.tx` (wired for you by @sabeesoft/idempotix-nestjs).
const store = createPrismaIdempotencyStore({
  client: () => transactionHost.tx,
  tableName: 'app.idempotency_keys', // optional, default "idempotency_keys"
});
```

The `client` callback runs on every store call, which is what lets the store follow the current transaction instead of capturing one client at construction time.

## How the SQL behaves

- `tryAcquire` is a single `INSERT … ON CONFLICT (scope, key) DO UPDATE … WHERE status = 'processing' AND locked_until <= now` — a fresh key inserts, an expired processing lock is reclaimed in place, anything else is a conflict. No unique-violation error is ever raised inside your transaction.
- `findForUpdate` is `SELECT … FOR UPDATE`, so a completed-vs-processing decision is made under a row lock.
- `markCompleted` stores the response body as `jsonb`; a JSON `null` body (e.g. a 204) is stored as `'null'::jsonb`, distinct from SQL `NULL`.
- The only identifier ever interpolated into SQL is the table name, validated as `<table>` or `<schema>.<table>` (letters, digits, underscores) — all values are bound parameters.

## Expired rows

The store never deletes rows on its own. Run this from a scheduled job:

```sql
DELETE FROM idempotency_keys WHERE locked_until < now();
```

`locked_until` is the processing-lock expiry while a key is `processing` and the replay-retention expiry once it is `completed`, so one statement covers both.

## Running this package's tests

The contract suite runs against a real PostgreSQL started with Testcontainers, so a Docker-compatible runtime is needed. With Docker installed nothing else is required. With rootless podman:

```bash
systemctl --user enable --now podman.socket
echo 'docker.host=unix:///run/user/1000/podman/podman.sock' > ~/.testcontainers.properties
```

The test disables Testcontainers' Ryuk reaper automatically when it detects a podman socket (rootless podman cannot run it) and stops every container it starts. Without any runtime the suite is reported as **skipped**, not passed.
