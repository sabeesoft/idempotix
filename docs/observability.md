# Observability

idempotix emits OpenTelemetry metrics through `@opentelemetry/api` only. Nothing is exported until your application registers a `MeterProvider`; with no SDK every instrument is a no-op. Resource attributes (`service.name`, `service.instance.id`, `deployment.environment.name`, …) come from your SDK setup — they are what let you aggregate across services and replicas below.

## Metric catalogue

Meter `idempotix`, all durations in seconds.

| Metric                                  | Instrument                                | Attributes                                                                                                                             | Emitted by                               |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `idempotix.requests`                    | counter `{request}`                       | `http.route`, `idempotix.outcome` = `acquired` \| `reclaimed` \| `replayed` \| `conflict` \| `fingerprint_mismatch` \| `key_generated` | `OtelIdempotencyMetrics`                 |
| `idempotix.processing`                  | up-down counter `{request}`               | `http.route`                                                                                                                           | `OtelIdempotencyMetrics`                 |
| `idempotix.handler.duration`            | histogram `s`                             | `http.route`, `idempotix.result` = `success` \| `error`                                                                                | `OtelIdempotencyMetrics`                 |
| `idempotix.transaction.duration`        | histogram `s`                             | `http.route`, `idempotix.transaction.outcome` = `commit` \| `rollback`, `error.type`                                                   | interceptor around `runInTransaction`    |
| `db.client.operation.duration`          | histogram `s`                             | `db.system.name`, `db.operation.name`, `db.collection.name` (Prisma only), `error.type`                                                | `instrumentPrisma` / `instrumentTypeorm` |
| `db.client.connection.count`            | observable up-down counter `{connection}` | `db.client.connection.pool.name`, `db.client.connection.state` = `idle` \| `used`                                                      | `instrumentPgPool`                       |
| `db.client.connection.max`              | observable up-down counter `{connection}` | pool name                                                                                                                              | `instrumentPgPool`                       |
| `db.client.connection.pending_requests` | observable up-down counter `{request}`    | pool name                                                                                                                              | `instrumentPgPool`                       |
| `db.client.connection.wait_time`        | histogram `s`                             | pool name                                                                                                                              | `instrumentPgPool`                       |
| `db.client.connection.use_time`         | histogram `s`                             | pool name                                                                                                                              | `instrumentPgPool`                       |
| `db.client.connection.timeouts`         | counter `{timeout}`                       | pool name                                                                                                                              | `instrumentPgPool`                       |
| `idempotix.db.pool.errors`              | counter `{error}`                         | pool name, `error.type`                                                                                                                | `instrumentPgPool`                       |

Conventions:

- `http.route` is the route template (`POST /payments/:id`) or, for `IdempotixService`, the operation name you pass. Never a resolved URL.
- No attribute can carry an idempotency key, request id, user id, tenant, query text or parameters — the types do not have a slot for them.
- `error.type` is an error `code` (Postgres `42P01`, Prisma `P2028`) or class name; a transaction timeout shows as `idempotix.transaction.outcome=rollback` with `error.type=P2028`.
- `db.client.*` names follow the OpenTelemetry database semantic conventions (`db.client.operation.duration` is stable; the connection metrics are still _Development_ upstream and may be renamed by the spec).

## SDK bootstrap

Run before the application imports anything that creates instruments (in NestJS: first line of `main.ts`).

Prometheus scrape endpoint:

```ts
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  serviceName: 'payments-api',
  metricReaders: [new PrometheusExporter({ port: 9464, endpoint: '/metrics' })],
});
sdk.start();
```

OTLP push (collector, vendor):

```ts
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  serviceName: 'payments-api',
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: 'http://otel-collector:4318/v1/metrics' }),
      exportIntervalMillis: 15_000,
    }),
  ],
});
sdk.start();
```

Set `OTEL_SERVICE_INSTANCE_ID` (or the `service.instance.id` resource attribute) per replica; the SDK derives `service.name` from `serviceName`/`OTEL_SERVICE_NAME`.

## A per-database dashboard

The point of `db.client.connection.*` across every service that shares a database is to compare the sum of open connections with the server's `max_connections`. Give each pool a `poolName` that identifies the database (`payments-primary`), then in PromQL. Prometheus naming turns dots into underscores; whether a unit suffix such as `_seconds` is appended depends on the exporter (the OTel JS `PrometheusExporter` used in the example does not add one, an OTel Collector with `add_metric_suffixes` does) — adjust the names below to what your `/metrics` endpoint actually shows:

```promql
# open connections to the database across all services and replicas
sum by (db_client_connection_pool_name) (db_client_connection_count)

# ...against what the server allows (from postgres_exporter)
sum by (db_client_connection_pool_name) (db_client_connection_count)
  / on() group_left pg_settings_max_connections

# pool saturation per service: used vs max
sum by (service_name, db_client_connection_pool_name) (db_client_connection_count{db_client_connection_state="used"})
  / sum by (service_name, db_client_connection_pool_name) (db_client_connection_max)

# requests queueing for a connection (any sustained non-zero value means the pool is too small or something holds connections)
sum by (service_name) (db_client_connection_pending_requests)

# time spent waiting for a connection, p99
histogram_quantile(0.99, sum by (le, service_name) (rate(db_client_connection_wait_time_bucket[5m])))

# connection timeouts
sum by (service_name) (rate(db_client_connection_timeouts_total[5m]))
```

Idempotency behaviour:

```promql
# replay ratio per route — how much duplicate traffic the library absorbed
sum by (http_route) (rate(idempotix_requests_total{idempotix_outcome="replayed"}[5m]))
  / sum by (http_route) (rate(idempotix_requests_total[5m]))

# clients reusing keys with different payloads (a client bug, or an attack)
sum by (http_route) (rate(idempotix_requests_total{idempotix_outcome="fingerprint_mismatch"}[5m]))

# requests that ran without a real key (no protection) — should be 0 once clients are migrated
sum by (http_route) (rate(idempotix_requests_total{idempotix_outcome="key_generated"}[5m]))

# reclaimed locks — crashed or abandoned acquisitions
sum by (http_route) (rate(idempotix_requests_total{idempotix_outcome="reclaimed"}[5m]))

# transaction rollbacks by cause
sum by (http_route, error_type) (rate(idempotix_transaction_duration_count{idempotix_transaction_outcome="rollback"}[5m]))

# keys currently being processed
sum by (http_route) (idempotix_processing)
```

Alert suggestions: `pending_requests > 0` for 5 minutes, `timeouts` rate > 0, `reclaimed` rate > 0 (something is dying mid-request), and connection sum above 80 % of `max_connections`.
