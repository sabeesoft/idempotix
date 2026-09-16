import type {
  FindForUpdateInput,
  IdempotencyRecord,
  IdempotencyStore,
  JsonValue,
  MarkCompletedInput,
  PurgeExpiredInput,
  TryAcquireInput,
  TryAcquireResult,
} from '@sabeesoft/idempotix-core';

/**
 * The slice of a Prisma 7 client the store needs. Both `PrismaClient` and the
 * interactive-transaction client (`Prisma.TransactionClient`) satisfy it, as
 * does any `$extends`-ed client — the store never imports `@prisma/client`.
 */
export interface PrismaRawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface PrismaIdempotencyStoreOptions {
  /**
   * Resolves the client for the current call. Return the active interactive
   * transaction client (e.g. `() => transactionHost.tx`) so the idempotency
   * record joins the application's own transaction; return the plain client
   * for non-transactional use.
   */
  client: () => PrismaRawClient;
  /** Table holding the records. Optionally schema-qualified. Defaults to `idempotency_keys`. */
  tableName?: string;
}

const DEFAULT_TABLE_NAME = 'idempotency_keys';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The table name is the only identifier ever interpolated into SQL, so it is
 * validated strictly and double-quoted; every value goes through `$n` binding.
 */
function quoteTableName(tableName: string): string {
  const parts = tableName.split('.');
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new Error(
      `Invalid idempotency table name "${tableName}": expected <table> or <schema>.<table> ` +
        'using only letters, digits and underscores',
    );
  }
  return parts.map((part) => `"${part}"`).join('.');
}

interface Row {
  scope: string;
  key: string;
  request_hash: string;
  status: string;
  response_code: number | null;
  response_body: JsonValue | null;
  locked_until: Date;
  created_at: Date;
}

interface AcquireRow {
  inserted: boolean;
}

function toRecord(row: Row): IdempotencyRecord {
  const base = {
    scope: row.scope,
    key: row.key,
    requestHash: row.request_hash,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
  };
  if (row.status === 'completed') {
    if (row.response_code === null) {
      throw new Error(
        `invariant violation: completed idempotency record for key "${row.key}" has no response_code`,
      );
    }
    // A jsonb `null` comes back as JS null and is a real JSON null here; the
    // `completed` status is what distinguishes it from "not set".
    return {
      ...base,
      status: 'completed',
      responseCode: row.response_code,
      responseBody: row.response_body,
    };
  }
  if (row.status === 'processing') {
    return { ...base, status: 'processing', responseCode: null, responseBody: null };
  }
  throw new Error(`invariant violation: unknown idempotency status "${row.status}"`);
}

export function createPrismaIdempotencyStore(
  options: PrismaIdempotencyStoreOptions,
): IdempotencyStore {
  const table = quoteTableName(options.tableName ?? DEFAULT_TABLE_NAME);
  const { client } = options;

  const acquireSql =
    `INSERT INTO ${table} ` +
    '(scope, key, request_hash, status, response_code, response_body, locked_until, created_at) ' +
    "VALUES ($1, $2, $3, 'processing', NULL, NULL, $4, $5) " +
    'ON CONFLICT (scope, key) DO UPDATE SET ' +
    "request_hash = EXCLUDED.request_hash, status = 'processing', " +
    'response_code = NULL, response_body = NULL, locked_until = EXCLUDED.locked_until ' +
    `WHERE ${table}.status = 'processing' AND ${table}.locked_until <= $5 ` +
    'RETURNING (xmax = 0) AS inserted';

  const findSql =
    'SELECT scope, key, request_hash, status, response_code, response_body, locked_until, created_at ' +
    `FROM ${table} WHERE scope = $1 AND key = $2 FOR UPDATE`;

  const completeSql =
    `UPDATE ${table} SET status = 'completed', response_code = $3, ` +
    'response_body = $4::jsonb, locked_until = $5 WHERE scope = $1 AND key = $2';

  const purgeSql = `DELETE FROM ${table} WHERE locked_until < $1`;

  return {
    async tryAcquire(input: TryAcquireInput): Promise<TryAcquireResult> {
      const lockedUntil = new Date(input.now.getTime() + input.lockDurationMs);
      const rows = await client().$queryRawUnsafe<AcquireRow[]>(
        acquireSql,
        input.scope,
        input.key,
        input.requestHash,
        lockedUntil,
        input.now,
      );
      const row = rows[0];
      if (!row) {
        return { outcome: 'conflict' };
      }
      return { outcome: 'acquired', reclaimed: !row.inserted };
    },

    async findForUpdate(input: FindForUpdateInput): Promise<IdempotencyRecord | null> {
      const rows = await client().$queryRawUnsafe<Row[]>(findSql, input.scope, input.key);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async markCompleted(input: MarkCompletedInput): Promise<void> {
      const lockedUntil = new Date(input.now.getTime() + input.ttlMs);
      const updated = await client().$executeRawUnsafe(
        completeSql,
        input.scope,
        input.key,
        input.responseCode,
        JSON.stringify(input.responseBody),
        lockedUntil,
      );
      if (updated !== 1) {
        throw new Error(
          `markCompleted called for a record that does not exist (scope="${input.scope}", key="${input.key}")`,
        );
      }
    },

    async purgeExpired(input: PurgeExpiredInput): Promise<number> {
      return client().$executeRawUnsafe(purgeSql, input.now);
    },
  };
}
