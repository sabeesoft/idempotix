import { readFileSync } from 'node:fs';
import { runStoreContractSuite } from '@sabeesoft/idempotix-testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import { createTypeormIdempotencyStore, type EntityManagerLike } from './store.js';
import {
  containerRuntimeAvailable,
  warnNoContainerRuntime,
} from './test-support/container-runtime.js';

const TABLE = 'idempotency_keys';

const runtimeAvailable = containerRuntimeAvailable();
if (!runtimeAvailable) {
  warnNoContainerRuntime('the Postgres contract suite');
}

describe.skipIf(!runtimeAvailable)('TypeormIdempotencyStore (Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  // The store resolves its manager per call, so a transaction can swap this in.
  let current: EntityManagerLike;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    dataSource = new DataSource({ type: 'postgres', url: container.getConnectionUri() });
    await dataSource.initialize();
    current = dataSource.manager;
    const migration = readFileSync(new URL('../migration.sql', import.meta.url), 'utf8').replace(
      /^\s*--.*$/gm,
      '',
    );
    for (const statement of migration.split(';').filter((s) => s.trim().length > 0)) {
      await dataSource.query(statement);
    }
  });

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  runStoreContractSuite('TypeormIdempotencyStore', {
    runner: { describe, it, beforeEach, afterEach },
    createStore: () => createTypeormIdempotencyStore({ manager: () => current, tableName: TABLE }),
    cleanup: async () => {
      await dataSource.query(`TRUNCATE TABLE "${TABLE}"`);
    },
    runInTransaction: (fn) =>
      dataSource.transaction(async (manager) => {
        const previous = current;
        current = manager;
        try {
          return await fn();
        } finally {
          current = previous;
        }
      }),
  });
});
