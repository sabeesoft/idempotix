import { describe, expect, it } from 'vitest';
import * as idempotixPrisma from './index.js';

describe('public API surface', () => {
  it('exports every documented value', () => {
    expect(Object.keys(idempotixPrisma).sort()).toEqual([
      'createPrismaIdempotencyStore',
      'instrumentPrisma',
    ]);
  });

  it('rejects unsafe table names before touching the database', () => {
    const client = () => {
      throw new Error('must not be called');
    };
    expect(() =>
      idempotixPrisma.createPrismaIdempotencyStore({ client, tableName: 'keys; DROP TABLE x' }),
    ).toThrow(/Invalid idempotency table name/);
    expect(() =>
      idempotixPrisma.createPrismaIdempotencyStore({ client, tableName: 'a.b.c' }),
    ).toThrow(/Invalid idempotency table name/);
    expect(() =>
      idempotixPrisma.createPrismaIdempotencyStore({ client, tableName: 'app.idempotency_keys' }),
    ).not.toThrow();
  });
});
