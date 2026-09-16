import { InMemoryIdempotencyStore, NoopMetrics, SystemClock } from '@sabeesoft/idempotix-core';
import { describe, expect, it } from 'vitest';
import { IdempotixConfigurationError, resolveOptions } from './options.js';
import { OtelIdempotencyMetrics } from './otel-metrics.js';

const store = new InMemoryIdempotencyStore();

describe('resolveOptions', () => {
  it('applies defaults', () => {
    const resolved = resolveOptions({ store });
    expect(resolved.ttlMs).toBe(24 * 3_600_000);
    expect(resolved.lockTtlMs).toBe(60_000);
    expect(resolved.onMissingKey).toBe('generate');
    expect(resolved.tenant({})).toBeNull();
    expect(resolved.metrics).toBeInstanceOf(OtelIdempotencyMetrics);
    expect(resolved.runInTransaction).toBeUndefined();
    expect(resolved.clock).toBeInstanceOf(SystemClock);
  });

  it('resolves the metrics option', () => {
    expect(resolveOptions({ store, metrics: 'noop' }).metrics).toBeInstanceOf(NoopMetrics);
    expect(resolveOptions({ store, metrics: 'otel' }).metrics).toBeInstanceOf(
      OtelIdempotencyMetrics,
    );
    const custom = new NoopMetrics();
    expect(resolveOptions({ store, metrics: custom }).metrics).toBe(custom);
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

  it.each([
    [{ store, ttl: '1x' }, 'ttl'],
    [{ store, lockTtl: 'soon' }, 'lockTtl'],
    [{ store, onMissingKey: 'explode' as never }, 'onMissingKey'],
    [{ store, keyHeader: ' ' }, 'keyHeader'],
    [{ store, metrics: 'prometheus' as never }, 'metrics'],
    [{ store: {} as never }, 'store'],
  ])('rejects invalid configuration %#', (options, option) => {
    expect(() => resolveOptions(options)).toThrow(IdempotixConfigurationError);
    expect(() => resolveOptions(options)).toThrow(new RegExp(`"${option}"`));
  });
});
