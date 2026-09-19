import { readFileSync } from 'node:fs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type DataPoint,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from './generated/prisma/client.js';
import { instrumentPrisma } from './instrumentation.js';
import {
  containerRuntimeAvailable,
  warnNoContainerRuntime,
} from './test-support/container-runtime.js';

const runtimeAvailable = containerRuntimeAvailable();
if (!runtimeAvailable) {
  warnNoContainerRuntime('the Prisma instrumentation suite');
}

function points(metric: MetricData | undefined): DataPoint<unknown>[] {
  return metric?.dataPoints ?? [];
}

describe.skipIf(!runtimeAvailable)('instrumentPrisma (Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let raw: PrismaClient;
  let prisma: PrismaClient;
  let dispose: () => void;
  let originalConnect: pg.Pool['connect'];
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
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 3 });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- identity check after dispose()
    originalConnect = pool.connect;
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    const migration = readFileSync(
      new URL('../prisma/migration.sql', import.meta.url),
      'utf8',
    ).replace(/^\s*--.*$/gm, '');
    for (const statement of migration.split(';').filter((s) => s.trim().length > 0)) {
      await raw.$executeRawUnsafe(statement);
    }
    ({ client: prisma, dispose } = instrumentPrisma({
      client: raw,
      pool,
      poolName: 'primary',
      meterProvider: provider,
    }));
  });

  afterAll(async () => {
    await provider.shutdown();
    await raw.$disconnect();
    await pool.end();
    await container.stop();
  });

  it('records db.client.operation.duration for model, raw and in-transaction operations, with error.type on failure', async () => {
    await prisma.idempotencyKey.count();
    await prisma.$queryRawUnsafe('SELECT 1');
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT 2');
    });
    await expect(prisma.$queryRawUnsafe('SELECT * FROM no_such_table')).rejects.toThrow();

    const byName = await collect();
    const ops = byName.get('db.client.operation.duration');
    expect(ops?.descriptor.unit).toBe('s');
    const attrs = points(ops).map((p) => p.attributes);
    expect(attrs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          'db.system.name': 'postgresql',
          'db.operation.name': 'count',
          'db.collection.name': 'IdempotencyKey',
        }),
        expect.objectContaining({ 'db.operation.name': '$queryRawUnsafe' }),
        expect.objectContaining({ 'db.operation.name': '$executeRawUnsafe' }),
        expect.objectContaining({
          'db.operation.name': '$queryRawUnsafe',
          'error.type': expect.any(String) as unknown,
        }),
      ]),
    );
    // No query text or argument ever becomes an attribute.
    for (const a of attrs) {
      expect(
        Object.keys(a).every((k) =>
          ['db.system.name', 'db.operation.name', 'db.collection.name', 'error.type'].includes(k),
        ),
      ).toBe(true);
    }
  });

  it('observes pool state and records wait/use time per acquisition', async () => {
    const held = await pool.connect();
    const byName = await collect();

    const count = points(byName.get('db.client.connection.count'));
    const used = count.find((p) => p.attributes['db.client.connection.state'] === 'used');
    const idle = count.find((p) => p.attributes['db.client.connection.state'] === 'idle');
    expect(used?.value).toBeGreaterThanOrEqual(1);
    expect(idle?.value).toBe(pool.idleCount);
    expect(count.every((p) => p.attributes['db.client.connection.pool.name'] === 'primary')).toBe(
      true,
    );
    expect(points(byName.get('db.client.connection.max'))[0]?.value).toBe(3);
    expect(points(byName.get('db.client.connection.pending_requests'))[0]?.value).toBe(0);

    held.release();
    const after = await collect();
    const waitTime = after.get('db.client.connection.wait_time');
    const useTime = after.get('db.client.connection.use_time');
    expect(waitTime?.descriptor.unit).toBe('s');
    expect(points(waitTime).length).toBeGreaterThan(0);
    expect(points(useTime).length).toBeGreaterThan(0);
  });

  it('counts connection timeouts', async () => {
    const tiny = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 1,
      // Generous on purpose: the budget must comfortably cover establishing the
      // first connection (a cold CI runner needs far more than a few
      // milliseconds), while the second acquisition can only ever time out,
      // because the pool holds one connection and the test is holding it.
      connectionTimeoutMillis: 2_000,
    });
    const instrumented = instrumentPrisma({
      pool: tiny,
      poolName: 'tiny',
      meterProvider: provider,
    });
    const held = await tiny.connect();
    await expect(tiny.connect()).rejects.toThrow(/timeout/i);
    held.release();
    const byName = await collect();
    const timeouts = points(byName.get('db.client.connection.timeouts')).find(
      (p) => p.attributes['db.client.connection.pool.name'] === 'tiny',
    );
    expect(timeouts?.value).toBe(1);
    instrumented.dispose();
    await tiny.end();
  });

  it('dispose() restores the pool and stops observing', () => {
    dispose();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- identity check, not a call
    expect(pool.connect).toBe(originalConnect);
    expect(pool.listenerCount('acquire')).toBe(0);
    expect(pool.listenerCount('release')).toBe(0);
  });
});
