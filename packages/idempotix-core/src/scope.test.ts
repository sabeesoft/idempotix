import { describe, expect, it } from 'vitest';
import { InvalidScopePartError } from './errors.js';
import { buildScope } from './scope.js';

describe('buildScope', () => {
  it('joins tenant and route deterministically', () => {
    const scope = buildScope({ tenant: 'acme', route: 'POST /payments/:id' });
    expect(scope).toBe(`acme${String.fromCharCode(31)}POST /payments/:id`);
  });

  it('falls back to a constant tenant when tenant is missing', () => {
    const withNull = buildScope({ tenant: null, route: 'POST /payments/:id' });
    const withUndefined = buildScope({ route: 'POST /payments/:id' });
    expect(withNull).toBe(withUndefined);
  });

  it('falls back to a constant tenant when tenant is blank', () => {
    const blank = buildScope({ tenant: '   ', route: 'POST /payments/:id' });
    const missing = buildScope({ tenant: null, route: 'POST /payments/:id' });
    expect(blank).toBe(missing);
  });

  it('produces different scopes for different tenants on the same route', () => {
    const a = buildScope({ tenant: 'acme', route: 'POST /payments/:id' });
    const b = buildScope({ tenant: 'globex', route: 'POST /payments/:id' });
    expect(a).not.toBe(b);
  });

  it('throws when the tenant contains the separator character', () => {
    expect(() => buildScope({ tenant: `a${String.fromCharCode(31)}b`, route: 'x' })).toThrow(
      InvalidScopePartError,
    );
  });

  it('throws when the route contains the separator character', () => {
    expect(() => buildScope({ tenant: 'acme', route: `a${String.fromCharCode(31)}b` })).toThrow(
      InvalidScopePartError,
    );
  });
});
