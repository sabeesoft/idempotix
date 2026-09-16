// Imported first from main.ts so the SDK's global MeterProvider is registered
// before any idempotix or Prisma code creates its instruments.
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { NodeSDK } from '@opentelemetry/sdk-node';

const port = Number(process.env['METRICS_PORT'] ?? 9464);

export const sdk = new NodeSDK({
  serviceName: 'idempotix-example',
  metricReaders: [new PrometheusExporter({ port, endpoint: '/metrics' })],
});

sdk.start();
console.log(`metrics: http://localhost:${String(port)}/metrics`);

process.on('SIGTERM', () => {
  void sdk.shutdown();
});
