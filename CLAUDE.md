# idempotix

## Project Purpose

idempotix is a banking-grade idempotency library for HTTP endpoints (and later message consumers), built for NestJS. It is defined by three goals:

1. **Easy to configure** — one module registration and one decorator should be enough for a typical app.
2. **Built-in metrics** — OpenTelemetry metrics out of the box: idempotency behaviour plus the DB pool/query/transaction usage it causes.
3. **Uses the app's own DB client** — no separate connection, pool, or ORM. idempotix plugs into the Prisma client, TypeORM DataSource, etc. the application already uses, and joins the application's own transaction.

Correctness under concurrency and retries matters more than convenience.

## Non-Negotiable Principles

1. The idempotency record and the business write **must** be in the same DB transaction, through the app's own client. No separate pool, no Redis-only guarantees.
2. Core logic is framework- and ORM-agnostic. NestJS integration and each ORM live in their own packages.
3. Keys are always scoped: `client/tenant + route template + Idempotency-Key`.
4. Same key + different payload → `422`. Same key still processing → `409` with `Retry-After`. Completed → replay the stored response with `Idempotent-Replayed: true`.
5. If the business work fails, the transaction rolls back and the key disappears, so the client can retry.
6. Metrics must never contain high-cardinality attributes (idempotency key, request id, user id, raw URLs). Those go to traces/logs only.

## Tech Stack

- Node.js 24, TypeScript strict (pinned to `6.0.3` — see note below)
- NestJS (`^11.0.0 || ^12.0.0`)
- Prisma 7 with the Postgres driver adapter (`@prisma/adapter-pg`)
- TypeORM (Postgres) as the second first-class adapter
- PostgreSQL first; the store port stays DB-agnostic enough for others later
- `nestjs-cls` + `@nestjs-cls/transactional` for transaction propagation
- `@opentelemetry/api` for metrics/traces — **never** the OTel SDK itself
- pnpm workspaces + Turborepo, tsup (dual ESM+CJS build), Vitest, Changesets

**Why TypeScript is pinned to `6.0.3` and not left on `^`:** npm's `latest` tag now points to TypeScript 7.x, the new Go-native compiler. `typescript-eslint` and tsup's declaration-file pipeline require the pre-7 API, so `6.0.3` (exact, no caret) is used everywhere in this repo until the toolchain catches up. Re-check this pin before bumping.

**Why `tsconfig.base.json` sets `"ignoreDeprecations": "6.0"`:** tsup 8.5.1's DTS-bundling step unconditionally injects `baseUrl: "."` into the compiler options it hands to TypeScript (`tsup/dist/rollup.js`), even though no package here sets `baseUrl` itself. TypeScript 6.0 treats any `baseUrl` as a hard deprecation error (`TS5101`) ahead of its removal in 7.0. This flag silences that specific transitional class of error; it is not silencing anything this repo's own config introduces. Re-check whether it's still needed whenever tsup or typescript is upgraded.

**Why `tsconfig.base.json` sets `"types": ["node"]` explicitly:** tsup's DTS-bundling worker constructs its own isolated TypeScript program and does not reliably auto-discover `@types/node`'s ambient `node:*` module declarations the way a normal `tsc -p` invocation does — without this, `import { randomUUID } from 'node:crypto'`-style imports fail only inside the DTS build step (`TS2591: Cannot find name 'node:crypto'`) while the regular esbuild-based JS/CJS build and `tsc --noEmit` both succeed, which makes the failure easy to miss if you only run typecheck. Re-check whether it's still needed whenever tsup is upgraded.

**Convention: `undefined` means "not set", `null` means "the real value is null".** A jsonb-backed field like `response_body` can legitimately hold the JSON literal `null` (e.g. a 204 response) — that must stay distinguishable from "this record hasn't completed yet". Internal/mutable representations use `undefined` as the not-yet-set sentinel and only ever expose `null` in the public `IdempotencyRecord` shape for the fixed `status: 'processing'` variant (see `packages/idempotix-core/src/store.ts` and `in-memory-store.ts`). Any future adapter mapping a DB `NULL` column has the same distinction to make.

## Package Layout

npm scope: `@sabeesoft`. All packages live under `packages/`.

| Package                        | Responsibility                                                                                                                                                                        | Depends on |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `@sabeesoft/idempotix-core`    | State machine, fingerprinting (canonical JSON + hash), scope building, policies (TTL, required key, methods), domain errors, ports, in-memory store for tests. No NestJS/ORM imports. | —          |
| `@sabeesoft/idempotix-nestjs`  | `IdempotixModule.forRoot/forRootAsync`, `@Idempotent()`, interceptor (key extraction, replay, response headers), explicit service helper, metrics wiring.                             | core       |
| `@sabeesoft/idempotix-prisma`  | Prisma store adapter, Prisma query/transaction instrumentation via `$extends`, pg pool metrics, schema snippet.                                                                       | core       |
| `@sabeesoft/idempotix-typeorm` | TypeORM store adapter, entity, query/transaction instrumentation, pg pool metrics via the DataSource's driver.                                                                        | core       |
| `@sabeesoft/idempotix-testing` | Shared adapter contract test suite so any store adapter (including third-party ones) can verify itself.                                                                               | core       |

## Peer-Dependency Rule

NestJS packages, `@prisma/client`, `typeorm`, `nestjs-cls`, `@nestjs-cls/transactional`, and `@opentelemetry/api` are always **peerDependencies** of whichever package uses them — never bundled/regular dependencies. The app controls their versions. `idempotix-core` has none of these; it stays framework- and ORM-agnostic.

## Observability Convention

Instrument via `@opentelemetry/api` only. Never depend on or bundle a concrete OTel SDK or exporter — the consuming app owns SDK/exporter setup, and without one registered, metrics must be automatic no-ops. Metric attributes are limited to low-cardinality values (route template, operation, outcome, pool name); never idempotency keys, request ids, user ids, or raw URLs.

## Milestone Order

1. Monorepo skeleton, tooling, CI, package publishing setup. **(done)**
2. `@sabeesoft/idempotix-core` + ports + in-memory store + unit tests. **(done)**
3. Shared contract test suite. **(this repo's current state)**
4. `@sabeesoft/idempotix-prisma` store passing the contract suite (Testcontainers).
5. `@sabeesoft/idempotix-nestjs`: module, decorator, interceptor, explicit helper, e2e tests.
6. Metrics: idempotency metrics, then Prisma pool/query/transaction instrumentation.
7. `@sabeesoft/idempotix-typeorm` adapter + instrumentation, passing the same suites.
8. Documentation, examples app, first release.

Deferred to later releases: inbox pattern for message consumers (SQS/Kafka), transactional outbox, key propagation to downstream services via `nestjs-cls` + HTTP client interceptor, further adapters (Kysely, Drizzle, MikroORM).

## Build/Test/Lint Conventions

- Turborepo orchestrates `build`/`lint`/`typecheck`/`test` across the pnpm workspace graph; each task depends on `^build` (its dependencies' build output), so packages always typecheck/test against their siblings' **built** `dist/`, not raw source — this catches packaging mistakes (`exports`/`files`) immediately instead of only at publish time.
- No TypeScript project references — Turborepo + the pnpm workspace graph already provide correct build ordering.
- `moduleResolution: NodeNext` — relative imports need explicit `.js` extensions even in `.ts` source files (e.g. `import { x } from './x.js'`).
- Each package builds dual ESM+CJS via a single shared `tsup.config.base.ts` factory (`createTsupConfig()`), so bundler behaviour is changed in exactly one place for every package at once.
- ESLint is a single root flat config (`eslint.config.js`) using `typescript-eslint`'s `strictTypeChecked` + `stylisticTypeChecked`; no per-package ESLint config is needed.
- `@sabeesoft/idempotix-testing`'s `runStoreContractSuite()` is runner-agnostic on purpose: the caller injects `describe`/`it`/`beforeEach`/`afterEach` and assertions use `node:assert/strict`, so third-party adapter authors on Jest or `node:test` can run it without a `vitest` peer dependency. Every store adapter in this repo must register it in its own test file (see `packages/idempotix-testing/src/contract.test.ts` for the in-memory example); DB-backed adapters should also pass `runInTransaction` so the rollback scenario runs instead of being skipped.

## Versioning & Release

- [Changesets](https://github.com/changesets/changesets) manages independent per-package versions and changelogs.
- Every user-facing change needs a changeset (`pnpm changeset`).
- Packages publish to public npm under the `@sabeesoft` scope (`publishConfig.access: public`). The project's own `.npmrc` explicitly pins `@sabeesoft:registry` to `https://registry.npmjs.org/` — do not remove this. Some development machines for this account have a global `~/.npmrc` that maps the `@sabeesoft` scope to GitHub Packages instead (used by other, unrelated projects); without this project-level override, `pnpm publish` here would silently target the wrong registry.
- Release automation (GitHub Actions + `changesets/action`) opens a "Version Packages" PR and publishes on merge to `main`. No automatic publish happens outside that flow.

## Contribution Workflow

- Pre-commit (husky + lint-staged) only lints/formats staged files — it does not run the full build/typecheck/test suite. CI is the authoritative gate for that.
- Run `pnpm build && pnpm lint && pnpm typecheck && pnpm test` before opening a PR.
- No schema/migration is applied automatically by any adapter package — each ORM package ships a documented model/entity, a table-name option, and a migration example; cleanup of expired rows is either an opt-in scheduled purge or documented SQL for an external job.
