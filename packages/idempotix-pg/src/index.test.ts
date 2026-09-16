import { describe, expect, it } from 'vitest';
import * as idempotixPg from './index.js';

describe('public API surface', () => {
  it('exports every documented value', () => {
    expect(Object.keys(idempotixPg).sort()).toEqual(
      [
        'DB_SYSTEM_POSTGRESQL',
        'DEFAULT_TABLE_NAME',
        'IDEMPOTIX_METER_NAME',
        'IDEMPOTIX_METER_VERSION',
        'errorType',
        'instrumentPgPool',
        'postgresIdempotencySql',
        'quoteTableName',
        'secondsSince',
        'toIdempotencyRecord',
      ].sort(),
    );
  });

  it('errorType prefers a code, then a name, then a fallback', () => {
    expect(idempotixPg.errorType(Object.assign(new Error('x'), { code: '23505' }))).toBe('23505');
    expect(idempotixPg.errorType(new TypeError('x'))).toBe('TypeError');
    expect(idempotixPg.errorType('boom')).toBe('Error');
  });
});
