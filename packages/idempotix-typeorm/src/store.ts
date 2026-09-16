import type {
  FindForUpdateInput,
  IdempotencyRecord,
  IdempotencyStore,
  MarkCompletedInput,
  PurgeExpiredInput,
  TryAcquireInput,
  TryAcquireResult,
} from '@sabeesoft/idempotix-core';
import {
  postgresIdempotencySql,
  toIdempotencyRecord,
  type AcquireRow,
  type IdempotencyRow,
} from '@sabeesoft/idempotix-pg';

/**
 * The slice of a TypeORM `EntityManager` the store needs. `dataSource.manager`,
 * the manager handed to `dataSource.transaction(...)`, and
 * `@nestjs-cls/transactional`'s `host.tx` all satisfy it — the store never
 * imports `typeorm` at runtime.
 */
export interface EntityManagerLike {
  query<T = unknown>(query: string, parameters?: unknown[]): Promise<T>;
}

export interface TypeormIdempotencyStoreOptions {
  /**
   * Resolves the manager for the current call. Return the transaction's
   * manager (e.g. `() => transactionHost.tx`) so the idempotency record joins
   * the application's own transaction; return `dataSource.manager` for
   * non-transactional use.
   */
  manager: () => EntityManagerLike;
  /** Table holding the records. Optionally schema-qualified. Defaults to `idempotency_keys`. */
  tableName?: string;
}

/** TypeORM's Postgres runner returns `[rows, affected]` for UPDATE/DELETE. */
type WriteResult = [unknown[], number];

export function createTypeormIdempotencyStore(
  options: TypeormIdempotencyStoreOptions,
): IdempotencyStore {
  const sql = postgresIdempotencySql(options.tableName);
  const { manager } = options;

  return {
    async tryAcquire(input: TryAcquireInput): Promise<TryAcquireResult> {
      const lockedUntil = new Date(input.now.getTime() + input.lockDurationMs);
      const rows = await manager().query<AcquireRow[]>(sql.acquire, [
        input.scope,
        input.key,
        input.requestHash,
        lockedUntil,
        input.now,
      ]);
      const row = rows[0];
      if (!row) {
        return { outcome: 'conflict' };
      }
      return { outcome: 'acquired', reclaimed: !row.inserted };
    },

    async findForUpdate(input: FindForUpdateInput): Promise<IdempotencyRecord | null> {
      const rows = await manager().query<IdempotencyRow[]>(sql.find, [input.scope, input.key]);
      const row = rows[0];
      return row ? toIdempotencyRecord(row) : null;
    },

    async markCompleted(input: MarkCompletedInput): Promise<void> {
      const lockedUntil = new Date(input.now.getTime() + input.ttlMs);
      const [, updated] = await manager().query<WriteResult>(sql.complete, [
        input.scope,
        input.key,
        input.responseCode,
        JSON.stringify(input.responseBody),
        lockedUntil,
      ]);
      if (updated !== 1) {
        throw new Error(
          `markCompleted called for a record that does not exist (scope="${input.scope}", key="${input.key}")`,
        );
      }
    },

    async purgeExpired(input: PurgeExpiredInput): Promise<number> {
      const [, deleted] = await manager().query<WriteResult>(sql.purge, [input.now]);
      return deleted;
    },
  };
}
