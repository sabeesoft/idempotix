import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type DataPoint,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it } from 'vitest';
import { OtelIdempotencyMetrics } from './otel-metrics.js';

function setup(): {
  metrics: OtelIdempotencyMetrics;
  collect: () => Promise<Map<string, MetricData>>;
  shutdown: () => Promise<void>;
} {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    metrics: new OtelIdempotencyMetrics({ meterProvider: provider }),
    collect: async () => {
      const { resourceMetrics } = await reader.collect();
      const byName = new Map<string, MetricData>();
      for (const scope of resourceMetrics.scopeMetrics) {
        expect(scope.scope.name).toBe('idempotix');
        for (const metric of scope.metrics) {
          byName.set(metric.descriptor.name, metric);
        }
      }
      return byName;
    },
    shutdown: () => provider.shutdown(),
  };
}

function points(metric: MetricData | undefined): DataPoint<unknown>[] {
  return metric?.dataPoints ?? [];
}

describe('OtelIdempotencyMetrics', () => {
  let shutdown: () => Promise<void> = () => Promise.resolve();

  afterEach(async () => {
    await shutdown();
  });

  it('emits the idempotix.* instruments with low-cardinality attributes only', async () => {
    const s = setup();
    shutdown = s.shutdown;
    const route = 'POST /payments/:id';

    s.metrics.recordOutcome('acquired', { route });
    s.metrics.recordOutcome('replayed', { route });
    s.metrics.recordProcessingStarted({ route });
    s.metrics.recordProcessingEnded({ route });
    s.metrics.recordHandlerDuration(0.25, { route, outcome: 'success' });
    s.metrics.recordTransaction(0.5, { route, outcome: 'rollback', errorType: 'P2028' });
    s.metrics.recordTransaction(0.1, { route, outcome: 'commit' });

    const byName = await s.collect();

    const requests = byName.get('idempotix.requests');
    expect(requests?.descriptor.unit).toBe('{request}');
    expect(
      points(requests)
        .map((p) => [p.attributes['idempotix.outcome'], p.value])
        .sort(),
    ).toEqual([
      ['acquired', 1],
      ['replayed', 1],
    ]);
    expect(points(requests).every((p) => p.attributes['http.route'] === route)).toBe(true);

    const processing = points(byName.get('idempotix.processing'));
    expect(processing).toHaveLength(1);
    expect(processing[0]?.value).toBe(0);

    const handler = byName.get('idempotix.handler.duration');
    expect(handler?.descriptor.unit).toBe('s');
    expect(points(handler)[0]?.attributes).toEqual({
      'http.route': route,
      'idempotix.result': 'success',
    });

    const tx = byName.get('idempotix.transaction.duration');
    expect(tx?.descriptor.unit).toBe('s');
    expect(points(tx).map((p) => p.attributes)).toEqual(
      expect.arrayContaining([
        { 'http.route': route, 'idempotix.transaction.outcome': 'commit' },
        { 'http.route': route, 'idempotix.transaction.outcome': 'rollback', 'error.type': 'P2028' },
      ]),
    );

    // Nothing but the route template and enum values ever becomes an attribute.
    for (const metric of byName.values()) {
      for (const point of points(metric)) {
        expect(Object.keys(point.attributes).sort()).toEqual(
          expect.arrayContaining(['http.route']),
        );
        expect(
          Object.keys(point.attributes).every((k) =>
            [
              'http.route',
              'idempotix.outcome',
              'idempotix.result',
              'idempotix.transaction.outcome',
              'error.type',
            ].includes(k),
          ),
        ).toBe(true);
      }
    }
  });

  it('is a no-op against the API default provider (no SDK registered)', () => {
    const metrics = new OtelIdempotencyMetrics();
    expect(() => {
      metrics.recordOutcome('acquired', { route: 'POST /x' });
      metrics.recordHandlerDuration(1, { route: 'POST /x', outcome: 'error' });
    }).not.toThrow();
  });
});
