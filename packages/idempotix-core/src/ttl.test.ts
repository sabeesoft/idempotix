import { describe, expect, it } from 'vitest';
import { InvalidTtlError } from './errors.js';
import { parseTtlMs } from './ttl.js';

describe('parseTtlMs', () => {
  it.each([
    ['24h', 24 * 3_600_000],
    ['1h', 3_600_000],
    ['7d', 7 * 86_400_000],
    ['30m', 30 * 60_000],
    ['45s', 45_000],
    [' 24h ', 24 * 3_600_000],
  ])('parses "%s" as %i ms', (input, expected) => {
    expect(parseTtlMs(input)).toBe(expected);
  });

  it.each(['', '24', '24x', '-1h', '1.5h', '24H', 'h24'])(
    'throws InvalidTtlError for "%s"',
    (input) => {
      expect(() => parseTtlMs(input)).toThrow(InvalidTtlError);
    },
  );
});
