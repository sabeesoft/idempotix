import { describe, expect, it } from 'vitest';
import * as idempotixNestjs from './index.js';

describe('public API surface', () => {
  it('exports every documented value', () => {
    expect(Object.keys(idempotixNestjs).sort()).toEqual(
      [
        'IDEMPOTIX_OPTIONS',
        'IDEMPOTENT_REPLAYED_HEADER',
        'Idempotent',
        'IdempotixConfigurationError',
        'IdempotixInterceptor',
        'IdempotixModule',
        'IdempotixService',
        'IDEMPOTIX_METER_NAME',
        'IDEMPOTIX_METER_VERSION',
        'OtelIdempotencyMetrics',
      ].sort(),
    );
  });
});
