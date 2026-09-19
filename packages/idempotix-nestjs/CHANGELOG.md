# @sabeesoft/idempotix-nestjs

## 0.1.0

### Minor Changes

- 3362a50: First release. `IdempotixModule.forRoot/forRootAsync`, the `@Idempotent()` decorator and interceptor (key extraction, replay with `Idempotent-Replayed`, 422 on payload change, 409 with `Retry-After` while processing), `IdempotixService` for explicit multi-block flows, and OpenTelemetry metrics through `@opentelemetry/api`.

### Patch Changes

- Updated dependencies [3362a50]
  - @sabeesoft/idempotix-core@0.1.0
