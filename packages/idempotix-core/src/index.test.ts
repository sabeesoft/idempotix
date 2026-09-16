import { describe, expect, it } from 'vitest';
import * as idempotixCore from './index.js';

describe('public API surface', () => {
  it('exports every documented value', () => {
    expect(Object.keys(idempotixCore).sort()).toEqual(
      [
        'IdempotixError',
        'FingerprintMismatchError',
        'ConflictInProgressError',
        'UnsupportedPayloadValueError',
        'InvalidTtlError',
        'InvalidScopePartError',
        'SystemClock',
        'generateKey',
        'parseTtlMs',
        'buildScope',
        'fingerprint',
        'InMemoryIdempotencyStore',
        'NoopMetrics',
        'runIdempotent',
      ].sort(),
    );
  });
});
