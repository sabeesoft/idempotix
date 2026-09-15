import { describe, expect, it } from 'vitest';
import { IDEMPOTIX_PRISMA_VERSION } from './index.js';

describe('package scaffold', () => {
  it('exports a placeholder marker', () => {
    expect(IDEMPOTIX_PRISMA_VERSION).toBe('0.0.0-milestone-1');
  });
});
