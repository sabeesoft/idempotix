import type { IdempotencyRecord, JsonValue } from '@sabeesoft/idempotix-core';

export const DEFAULT_TABLE_NAME = 'idempotency_keys';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The table name is the only identifier ever interpolated into SQL, so it is
 * validated strictly and double-quoted; every value goes through `$n` binding.
 */
export function quoteTableName(tableName: string): string {
  const parts = tableName.split('.');
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new Error(
      `Invalid idempotency table name "${tableName}": expected <table> or <schema>.<table> ` +
        'using only letters, digits and underscores',
    );
  }
  return parts.map((part) => `"${part}"`).join('.');
}

/** A row of the idempotency table as PostgreSQL drivers return it. */
export interface IdempotencyRow {
  scope: string;
  key: string;
  request_hash: string;
  status: string;
  response_code: number | null;
  response_body: JsonValue | null;
  locked_until: Date;
  created_at: Date;
}

/** The single row `acquire` returns when the key was taken (fresh insert or reclaim). */
export interface AcquireRow {
  inserted: boolean;
}

export interface PostgresIdempotencySql {
  /**
   * `$1` scope, `$2` key, `$3` request hash, `$4` locked_until, `$5` now.
   * Inserts a fresh key, or reclaims an expired processing lock in place.
   * Returns one row (`inserted` = true for a fresh insert) or none on conflict.
   */
  acquire: string;
  /** `$1` scope, `$2` key. `SELECT … FOR UPDATE`. */
  find: string;
  /** `$1` scope, `$2` key, `$3` response code, `$4` JSON-encoded body, `$5` locked_until. */
  complete: string;
  /** `$1` now. */
  purge: string;
}

export function postgresIdempotencySql(
  tableName: string = DEFAULT_TABLE_NAME,
): PostgresIdempotencySql {
  const table = quoteTableName(tableName);
  return {
    acquire:
      `INSERT INTO ${table} ` +
      '(scope, key, request_hash, status, response_code, response_body, locked_until, created_at) ' +
      "VALUES ($1, $2, $3, 'processing', NULL, NULL, $4, $5) " +
      'ON CONFLICT (scope, key) DO UPDATE SET ' +
      "request_hash = EXCLUDED.request_hash, status = 'processing', " +
      'response_code = NULL, response_body = NULL, locked_until = EXCLUDED.locked_until ' +
      `WHERE ${table}.status = 'processing' AND ${table}.locked_until <= $5 ` +
      'RETURNING (xmax = 0) AS inserted',
    find:
      'SELECT scope, key, request_hash, status, response_code, response_body, locked_until, created_at ' +
      `FROM ${table} WHERE scope = $1 AND key = $2 FOR UPDATE`,
    complete:
      `UPDATE ${table} SET status = 'completed', response_code = $3, ` +
      'response_body = $4::jsonb, locked_until = $5 WHERE scope = $1 AND key = $2',
    purge: `DELETE FROM ${table} WHERE locked_until < $1`,
  };
}

export function toIdempotencyRecord(row: IdempotencyRow): IdempotencyRecord {
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
