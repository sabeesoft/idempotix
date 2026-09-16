import { InMemoryIdempotencyStore, NoopMetrics, SystemClock } from '@sabeesoft/idempotix-core';
import { describe, expect, it } from 'vitest';
import { IdempotixConfigurationError, resolveOptions } from './options.js';

const store = new InMemoryIdempotencyStore();

describe('resolveOptions', () => {
  it('applies defaults', () => {
    const resolved = resolveOptions({ store });
    expect(resolved.ttlMs).toBe(24 * 3_600_000);
    expect(resolved.lockTtlMs).toBe(60_000);
    expect(resolved.onMissingKey).toBe('generate');
    expect(resolved.tenant({})).toBeNull();
    expect(resolved.metrics).toBeInstanceOf(NoopMetrics);
    expect(resolved.clock).toBeInstanceOf(SystemClock);
  });

  it('reads the Idempotency-Key header case-insensitively and trims it', () => {
    const { keyExtractor } = resolveOptions({ store });
    expect(keyExtractor({ headers: { 'idempotency-key': '  abc  ' } })).toBe('abc');
    expect(keyExtractor({ headers: { 'idempotency-key': ['first', 'second'] } })).toBe('first');
    expect(keyExtractor({ headers: {} })).toBeUndefined();
    expect(keyExtractor({ headers: { 'idempotency-key': '   ' } })).toBeUndefined();
  });

  it('honours a custom header name', () => {
    const { keyExtractor } = resolveOptions({ store, keyHeader: 'X-Request-Key' });
    expect(keyExtractor({ headers: { 'x-request-key': 'k' } })).toBe('k');
  });

  it('runInTransaction defaults to a pass-through', async () => {
    const { runInTransaction } = resolveOptions({ store });
    await expect(runInTransaction(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it.each([
    [{ store, ttl: '1x' }, 'ttl'],
    [{ store, lockTtl: 'soon' }, 'lockTtl'],
    [{ store, onMissingKey: 'explode' as never }, 'onMissingKey'],
    [{ store, keyHeader: ' ' }, 'keyHeader'],
    [{ store: {} as never }, 'store'],
  ])('rejects invalid configuration %#', (options, option) => {
    expect(() => resolveOptions(options)).toThrow(IdempotixConfigurationError);
    expect(() => resolveOptions(options)).toThrow(new RegExp(`"${option}"`));
  });
});
