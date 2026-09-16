import { describe, expect, it } from 'vitest';
import { postgresIdempotencySql, quoteTableName, toIdempotencyRecord } from './sql.js';

describe('quoteTableName', () => {
  it('quotes plain and schema-qualified names', () => {
    expect(quoteTableName('idempotency_keys')).toBe('"idempotency_keys"');
    expect(quoteTableName('app.idempotency_keys')).toBe('"app"."idempotency_keys"');
  });

  it.each(['keys; DROP TABLE x', 'a.b.c', '"quoted"', '1abc', ''])('rejects %j', (name) => {
    expect(() => quoteTableName(name)).toThrow(/Invalid idempotency table name/);
  });
});

describe('postgresIdempotencySql', () => {
  it('parameterises every value and interpolates only the quoted table name', () => {
    const sql = postgresIdempotencySql('app.keys');
    for (const statement of Object.values(sql)) {
      expect(statement).toContain('"app"."keys"');
      expect(statement).not.toContain('app.keys'); // never unquoted
    }
    expect(sql.acquire).toMatch(/\$1.*\$2.*\$3.*\$4.*\$5/);
    expect(sql.complete).toMatch(/\$3.*\$4.*\$5.*\$1.*\$2/);
    expect(sql.acquire).toContain('ON CONFLICT (scope, key) DO UPDATE');
    expect(sql.acquire).toContain('RETURNING (xmax = 0) AS inserted');
    expect(sql.find).toContain('FOR UPDATE');
    expect(sql.complete).toContain('$4::jsonb');
  });
});

describe('toIdempotencyRecord', () => {
  const base = {
    scope: 's',
    key: 'k',
    request_hash: 'h',
    locked_until: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
  };

  it('maps a processing row to fixed nulls', () => {
    expect(
      toIdempotencyRecord({
        ...base,
        status: 'processing',
        response_code: null,
        response_body: null,
      }),
    ).toMatchObject({ status: 'processing', responseCode: null, responseBody: null });
  });

  it('keeps a JSON null body on a completed row', () => {
    expect(
      toIdempotencyRecord({
        ...base,
        status: 'completed',
        response_code: 204,
        response_body: null,
      }),
    ).toMatchObject({ status: 'completed', responseCode: 204, responseBody: null });
  });

  it('rejects a completed row without a response code', () => {
    expect(() =>
      toIdempotencyRecord({ ...base, status: 'completed', response_code: null, response_body: {} }),
    ).toThrow(/invariant violation/);
  });

  it('rejects an unknown status', () => {
    expect(() =>
      toIdempotencyRecord({ ...base, status: 'weird', response_code: null, response_body: null }),
    ).toThrow(/unknown idempotency status/);
  });
});
