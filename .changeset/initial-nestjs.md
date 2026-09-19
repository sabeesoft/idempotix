---
'@sabeesoft/idempotix-nestjs': minor
---

First release. `IdempotixModule.forRoot/forRootAsync`, the `@Idempotent()` decorator and interceptor (key extraction, replay with `Idempotent-Replayed`, 422 on payload change, 409 with `Retry-After` while processing), `IdempotixService` for explicit multi-block flows, and OpenTelemetry metrics through `@opentelemetry/api`.
