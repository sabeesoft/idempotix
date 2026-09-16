import { describe, expect, it } from 'vitest';
import { generateKey } from './key.js';

describe('generateKey', () => {
  it('returns a valid UUID string', () => {
    expect(generateKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns a different value on each call', () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});
