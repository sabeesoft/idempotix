import { describe, expect, it } from 'vitest';
import * as idempotixTypeorm from './index.js';

describe('public API surface', () => {
  it('exports every documented value', () => {
    expect(Object.keys(idempotixTypeorm).sort()).toEqual(
      [
        'IdempotencyKeyEntity',
        'createTypeormIdempotencyStore',
        'instrumentTypeorm',
        'operationName',
      ].sort(),
    );
  });

  it('rejects unsafe table names before touching the database', () => {
    const manager = () => {
      throw new Error('must not be called');
    };
    expect(() =>
      idempotixTypeorm.createTypeormIdempotencyStore({ manager, tableName: 'keys; DROP TABLE x' }),
    ).toThrow(/Invalid idempotency table name/);
    expect(() =>
      idempotixTypeorm.createTypeormIdempotencyStore({
        manager,
        tableName: 'app.idempotency_keys',
      }),
    ).not.toThrow();
  });

  it.each([
    ['SELECT 1', 'SELECT'],
    ['  insert into t values (1)', 'INSERT'],
    ['/* hint */ UPDATE t SET a = 1', 'UPDATE'],
    ['START TRANSACTION', 'START'],
    ['COMMIT', 'COMMIT'],
    ['WITH cte AS (SELECT 1) SELECT * FROM cte', 'WITH'],
    ['EXPLAIN SELECT 1', 'OTHER'],
    ['', 'OTHER'],
  ])('operationName(%j) = %s', (sql, expected) => {
    expect(idempotixTypeorm.operationName(sql)).toBe(expected);
  });

  it('refuses to instrument an uninitialized data source', () => {
    expect(() =>
      idempotixTypeorm.instrumentTypeorm({
        dataSource: { isInitialized: false, subscribers: [], driver: {} },
      }),
    ).toThrow(/after dataSource.initialize/);
  });
});
