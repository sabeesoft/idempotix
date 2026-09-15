# idempotix

Banking-grade idempotency for HTTP endpoints — NestJS, Prisma, TypeORM.

![CI](https://github.com/sabeesoft/idempotix/actions/workflows/ci.yml/badge.svg)

## What is idempotix?

idempotix makes NestJS endpoints (and later message consumers) idempotent by joining your application's own database transaction — no separate pool, no Redis-only guarantees. It ships with OpenTelemetry metrics for idempotency behaviour and the DB pool/query/transaction usage it causes.

## Packages

| Package                                                      | npm           | Purpose                                                                      |
| ------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------- |
| [`@sabeesoft/idempotix-core`](packages/idempotix-core)       | _unpublished_ | Framework/ORM-agnostic state machine, fingerprinting, ports, in-memory store |
| [`@sabeesoft/idempotix-nestjs`](packages/idempotix-nestjs)   | _unpublished_ | NestJS module, `@Idempotent()` decorator, interceptor                        |
| [`@sabeesoft/idempotix-prisma`](packages/idempotix-prisma)   | _unpublished_ | Prisma store adapter + instrumentation                                       |
| [`@sabeesoft/idempotix-typeorm`](packages/idempotix-typeorm) | _unpublished_ | TypeORM store adapter + instrumentation                                      |
| [`@sabeesoft/idempotix-testing`](packages/idempotix-testing) | _unpublished_ | Shared adapter contract test suite                                           |

## Installation

Coming after the first publish.

## Quick Start

TBD — see the milestone plan in [CLAUDE.md](CLAUDE.md).

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## License

[Apache-2.0](LICENSE)
