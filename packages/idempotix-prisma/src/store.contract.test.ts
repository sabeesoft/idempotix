import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { runStoreContractSuite } from '@sabeesoft/idempotix-testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import { PrismaClient } from './generated/prisma/client.js';
import { createPrismaIdempotencyStore, type PrismaRawClient } from './store.js';
import {
  containerRuntimeAvailable,
  warnNoContainerRuntime,
} from './test-support/container-runtime.js';

const TABLE = 'idempotency_keys';

const runtimeAvailable = containerRuntimeAvailable();
if (!runtimeAvailable) {
  warnNoContainerRuntime('the Postgres contract suite');
}

describe.skipIf(!runtimeAvailable)('PrismaIdempotencyStore (Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  // The store resolves its client per call, so a transaction can swap this in.
  let current: PrismaRawClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    current = prisma;
    const migration = readFileSync(new URL('../prisma/migration.sql', import.meta.url), 'utf8')
      // Strip `--` comments first: they may contain semicolons.
      .replace(/^\s*--.*$/gm, '');
    for (const statement of migration.split(';').filter((s) => s.trim().length > 0)) {
      await prisma.$executeRawUnsafe(statement);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
    await container.stop();
  });

  runStoreContractSuite('PrismaIdempotencyStore', {
    runner: { describe, it, beforeEach, afterEach },
    createStore: () => createPrismaIdempotencyStore({ client: () => current, tableName: TABLE }),
    cleanup: async () => {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${TABLE}"`);
    },
    runInTransaction: (fn) =>
      prisma.$transaction(async (tx) => {
        const previous = current;
        current = tx;
        try {
          return await fn();
        } finally {
          current = previous;
        }
      }),
  });
});
