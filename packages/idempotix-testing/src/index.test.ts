import { describe, expect, it } from 'vitest';
import * as idempotixTesting from './index.js';

describe('public API surface', () => {
  it('exports every documented value', () => {
    expect(Object.keys(idempotixTesting).sort()).toEqual(['runStoreContractSuite']);
  });
});
