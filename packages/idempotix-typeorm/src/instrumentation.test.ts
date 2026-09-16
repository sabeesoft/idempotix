import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type DataPoint,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyKeyEntity } from './entity.js';
import { instrumentTypeorm } from './instrumentation.js';
import {
  containerRuntimeAvailable,
  warnNoContainerRuntime,
} from './test-support/container-runtime.js';

const runtimeAvailable = containerRuntimeAvailable();
if (!runtimeAvailable) {
  warnNoContainerRuntime('the TypeORM instrumentation suite');
}

function points(metric: MetricData | undefined): DataPoint<unknown>[] {
  return metric?.dataPoints ?? [];
}

describe.skipIf(!runtimeAvailable)('instrumentTypeorm (Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let dispose: () => void;
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({ readers: [reader] });

  async function collect(): Promise<Map<string, MetricData>> {
    const { resourceMetrics } = await reader.collect();
    const byName = new Map<string, MetricData>();
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        byName.set(metric.descriptor.name, metric);
      }
    }
    return byName;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    // The entity drives the schema here, proving it matches migration.sql's table.
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      entities: [IdempotencyKeyEntity],
      synchronize: true,
      extra: { max: 3 },
    });
    await dataSource.initialize();
    ({ dispose } = instrumentTypeorm({ dataSource, poolName: 'primary', meterProvider: provider }));
  });

  afterAll(async () => {
    await provider.shutdown();
    await dataSource.destroy();
    await container.stop();
  });

  it('records db.client.operation.duration per statement keyword, with error.type on failure', async () => {
    await dataSource.getRepository(IdempotencyKeyEntity).count();
    await dataSource.query('SELECT 1');
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT 2');
    });
    await expect(dataSource.query('SELECT * FROM no_such_table')).rejects.toThrow();

    const ops = (await collect()).get('db.client.operation.duration');
    expect(ops?.descriptor.unit).toBe('s');
    const attrs = points(ops).map((p) => p.attributes);
    expect(attrs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ 'db.system.name': 'postgresql', 'db.operation.name': 'SELECT' }),
        expect.objectContaining({ 'db.operation.name': 'START' }),
        expect.objectContaining({ 'db.operation.name': 'COMMIT' }),
        expect.objectContaining({ 'db.operation.name': 'SELECT', 'error.type': '42P01' }),
      ]),
    );
    for (const a of attrs) {
      expect(
        Object.keys(a).every((k) =>
          ['db.system.name', 'db.operation.name', 'error.type'].includes(k),
        ),
      ).toBe(true);
    }
  });

  it("observes the driver's pg.Pool", async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    const byName = await collect();
    const count = points(byName.get('db.client.connection.count'));
    expect(
      count.find((p) => p.attributes['db.client.connection.state'] === 'used')?.value,
    ).toBeGreaterThanOrEqual(1);
    expect(count.every((p) => p.attributes['db.client.connection.pool.name'] === 'primary')).toBe(
      true,
    );
    expect(points(byName.get('db.client.connection.max'))[0]?.value).toBe(3);
    await runner.release();
    const after = await collect();
    expect(points(after.get('db.client.connection.use_time')).length).toBeGreaterThan(0);
    expect(points(after.get('db.client.connection.wait_time')).length).toBeGreaterThan(0);
  });

  it('dispose() removes the subscriber and pool hooks', () => {
    const before = dataSource.subscribers.length;
    dispose();
    expect(dataSource.subscribers.length).toBe(before - 1);
  });
});
