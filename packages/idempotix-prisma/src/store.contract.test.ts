import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { runStoreContractSuite } from '@sabeesoft/idempotix-testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import { PrismaClient } from './generated/prisma/client.js';
import { createPrismaIdempotencyStore, type PrismaRawClient } from './store.js';

const TABLE = 'idempotency_keys';

/**
 * Testcontainers needs a Docker-compatible runtime. Detect the usual ways one
 * is configured so a missing runtime reports as *skipped*, not as a confusing
 * failure — and so CI (which always has Docker) never skips silently.
 */
function configuredDockerHost(): string | undefined {
  const fromEnv = process.env['DOCKER_HOST'];
  if (fromEnv) {
    return fromEnv;
  }
  const props = join(homedir(), '.testcontainers.properties');
  if (!existsSync(props)) {
    return undefined;
  }
  return /^\s*docker\.host\s*=\s*(\S+)/m.exec(readFileSync(props, 'utf8'))?.[1];
}

function containerRuntimeAvailable(): boolean {
  const host = configuredDockerHost();
  if (host) {
    // Rootless podman cannot run Testcontainers' privileged Ryuk reaper; every
    // container here is stopped in afterAll anyway. testcontainers-node only
    // reads this as an environment variable, not from the properties file.
    if (host.includes('podman')) {
      process.env['TESTCONTAINERS_RYUK_DISABLED'] ??= 'true';
    }
    return true;
  }
  return ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock')].some((p) =>
    existsSync(p),
  );
}

const runtimeAvailable = containerRuntimeAvailable();
if (!runtimeAvailable) {
  console.warn(
    '[idempotix-prisma] No container runtime found (DOCKER_HOST, ~/.testcontainers.properties ' +
      'or a docker.sock) — skipping the Postgres contract suite.',
  );
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
