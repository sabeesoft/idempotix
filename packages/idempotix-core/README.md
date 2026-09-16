# @sabeesoft/idempotix-core

The framework- and ORM-agnostic heart of [idempotix](../../README.md): the idempotency state machine, request fingerprinting, key scoping, the ports every adapter implements, and an in-memory store for tests. Zero runtime dependencies. You normally use it through `@sabeesoft/idempotix-nestjs`; import it directly to build an adapter, an integration for another framework, or to run the orchestration yourself.

## `runIdempotent()`

```ts
const result = await runIdempotent({
  store, // IdempotencyStore
  metrics: new NoopMetrics(), // IdempotencyMetrics
  clock: new SystemClock(), // Clock
  scope: buildScope({ tenant: 'acme', route: 'POST /payments/:id' }),
  key: 'client-supplied-key',
  route: 'POST /payments/:id', // low-cardinality, metrics only
  payload: { params, query, body },
  ttlMs: parseTtlMs('24h'),
  lockDurationMs: parseTtlMs('60s'),
  handler: async () => ({ responseCode: 201, responseBody: { id: 'p1' } }),
});
// { replayed: boolean, responseCode, responseBody }
```

| Store state for `scope + key`      | Result                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| absent                             | `tryAcquire` inserts a `processing` record, the handler runs, `markCompleted` stores the response                                   |
| `completed`, same fingerprint      | returns the stored response with `replayed: true`; the handler is not called                                                        |
| `completed`, different fingerprint | throws `FingerprintMismatchError`                                                                                                   |
| `processing`, lock not expired     | throws `ConflictInProgressError` (`retryAfterMs`)                                                                                   |
| `processing`, lock expired         | reclaimed in place; the handler runs again                                                                                          |
| handler throws                     | the error propagates untouched and nothing is marked completed — inside a transaction the record rolls back with the business write |

Errors extend `IdempotixError` and carry a `code`; they are semantic, not HTTP — the NestJS package maps them to 422/409.

## Fingerprinting

`fingerprint(payload)` is the SHA-256 of a canonical JSON form: object keys sorted recursively, array order preserved, `Date` → ISO string, `undefined` object properties dropped and `undefined` array elements turned into `null` (exactly what `JSON.stringify` does). Values JSON cannot faithfully represent — functions, symbols, bigints, `Map`, `Set`, `RegExp` — throw `UnsupportedPayloadValueError` naming the path rather than being silently dropped, because a dropped field could hide a real payload difference.

## Scoping

`buildScope({ tenant, route })` joins an optional tenant id and a route template with an ASCII unit separator, so different tenants and routes never collide even if their names contain `/` or `:`. Keys are always stored under `(scope, key)`.

## Ports

- `IdempotencyStore` — `tryAcquire`, `findForUpdate`, `markCompleted`, `purgeExpired`. `tryAcquire` must insert-or-reclaim atomically and report `reclaimed`; a completed record is never reclaimed. See `@sabeesoft/idempotix-testing` for the contract every implementation must pass and `@sabeesoft/idempotix-pg` for the reference PostgreSQL SQL.
- `IdempotencyMetrics` — semantic events (`recordOutcome`, processing start/end, handler and transaction durations). `MetricAttributes` has a single `route` field on purpose: nothing high-cardinality can be passed. `NoopMetrics` is the default; `@sabeesoft/idempotix-nestjs` provides the OpenTelemetry implementation.
- `Clock` — `now()`; inject a fake in tests.

`InMemoryIdempotencyStore` implements the store port for unit tests (no transactions, so no rollback semantics). `parseTtlMs('24h')` accepts integer `s`/`m`/`h`/`d` durations. `generateKey()` returns a UUID for integrations that generate a key when the caller sent none.
