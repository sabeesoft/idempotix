import { describe, expect, it } from 'vitest';
import { UnsupportedPayloadValueError } from './errors.js';
import { fingerprint } from './fingerprint.js';

describe('fingerprint', () => {
  it('produces the same hash regardless of object key order', () => {
    const a = fingerprint({ amount: 100, currency: 'EUR' });
    const b = fingerprint({ currency: 'EUR', amount: 100 });
    expect(a).toBe(b);
  });

  it('produces the same hash for equal nested structures with reordered keys', () => {
    const a = fingerprint({ payer: { id: 1, name: 'A' }, items: [{ sku: 'x', qty: 2 }] });
    const b = fingerprint({ items: [{ qty: 2, sku: 'x' }], payer: { name: 'A', id: 1 } });
    expect(a).toBe(b);
  });

  it('produces a different hash when array element order changes', () => {
    const a = fingerprint({ items: ['a', 'b'] });
    const b = fingerprint({ items: ['b', 'a'] });
    expect(a).not.toBe(b);
  });

  it('produces a different hash for genuinely different payloads', () => {
    const a = fingerprint({ amount: 100 });
    const b = fingerprint({ amount: 200 });
    expect(a).not.toBe(b);
  });

  it('fingerprints Date values via their ISO string', () => {
    const a = fingerprint({ at: new Date('2026-01-01T00:00:00.000Z') });
    const b = fingerprint({ at: '2026-01-01T00:00:00.000Z' });
    expect(a).toBe(b);
  });

  it('produces a 64-character hex sha256 digest', () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['a function', { cb: () => 1 }],
    ['a Map', { m: new Map() }],
    ['a Set', { s: new Set() }],
    ['a RegExp', { r: /x/u }],
    ['a bigint', { n: 1n }],
    ['a symbol', { s: Symbol('x') }],
  ])('throws UnsupportedPayloadValueError for a payload containing %s', (_label, payload) => {
    expect(() => fingerprint(payload)).toThrow(UnsupportedPayloadValueError);
  });

  it('reports the offending path in the thrown error', () => {
    try {
      fingerprint({ a: { b: [1, 2n] } });
      expect.fail('expected fingerprint to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedPayloadValueError);
      expect((err as UnsupportedPayloadValueError).path).toBe('$.a.b[1]');
    }
  });
});
