import {
  IdempotixError,
  NoopMetrics,
  SystemClock,
  parseTtlMs,
  type Clock,
  type IdempotencyMetrics,
  type IdempotencyStore,
} from '@sabeesoft/idempotix-core';

export const IDEMPOTIX_OPTIONS = Symbol('IDEMPOTIX_OPTIONS');

export type OnMissingKey = 'generate' | 'reject';

export interface IdempotixModuleOptions {
  /** The store adapter, e.g. `createPrismaIdempotencyStore({ client: () => host.tx })`. */
  store: IdempotencyStore;
  /** Replay-retention window for completed keys. Default `'24h'`. */
  ttl?: string;
  /** How long a crashed/abandoned acquisition blocks retries before it can be reclaimed. Default `'60s'`. */
  lockTtl?: string;
  /** Request header carrying the idempotency key. Default `'Idempotency-Key'`. */
  keyHeader?: string;
  /** Replaces the header lookup entirely. Return `undefined` when the request carries no key. */
  keyExtractor?: (request: unknown) => string | undefined;
  /** What to do when no key is present: generate one (request runs unprotected) or reject with 400. Default `'generate'`. */
  onMissingKey?: OnMissingKey;
  /** Tenant/client discriminator for the scope. Default: single tenant. */
  tenant?: (request: unknown) => string | null | undefined;
  /**
   * Runs the guarded handler inside the application's transaction, e.g.
   * `(fn) => transactionHost.withTransaction(fn)`. Without it the handler runs
   * outside any transaction managed by idempotix.
   */
  runInTransaction?: <R>(fn: () => Promise<R>) => Promise<R>;
  /** Default: no-op metrics. */
  metrics?: IdempotencyMetrics;
  /** Default: system clock. */
  clock?: Clock;
}

export interface ResolvedIdempotixOptions {
  store: IdempotencyStore;
  ttlMs: number;
  lockTtlMs: number;
  keyExtractor: (request: unknown) => string | undefined;
  onMissingKey: OnMissingKey;
  tenant: (request: unknown) => string | null | undefined;
  runInTransaction: <R>(fn: () => Promise<R>) => Promise<R>;
  metrics: IdempotencyMetrics;
  clock: Clock;
}

export class IdempotixConfigurationError extends IdempotixError {
  readonly code = 'INVALID_CONFIGURATION';

  constructor(
    public readonly option: string,
    detail: string,
  ) {
    super(`Invalid IdempotixModule option "${option}": ${detail}`);
    this.name = 'IdempotixConfigurationError';
  }
}

const DEFAULT_TTL = '24h';
const DEFAULT_LOCK_TTL = '60s';
const DEFAULT_KEY_HEADER = 'Idempotency-Key';

export function parseDuration(option: string, value: string): number {
  try {
    return parseTtlMs(value);
  } catch {
    throw new IdempotixConfigurationError(
      option,
      `"${value}" is not a duration — use an integer followed by s, m, h or d (e.g. "24h")`,
    );
  }
}

function headerExtractor(headerName: string): (request: unknown) => string | undefined {
  const name = headerName.toLowerCase();
  return (request) => {
    const headers = (request as { headers?: Record<string, unknown> }).headers;
    const raw: unknown = headers?.[name];
    const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  };
}

export function resolveOptions(options: IdempotixModuleOptions): ResolvedIdempotixOptions {
  if (typeof options.store !== 'object' || typeof options.store.tryAcquire !== 'function') {
    throw new IdempotixConfigurationError(
      'store',
      'an IdempotencyStore implementation is required',
    );
  }
  // Widened on purpose: the check guards JavaScript callers the types can't.
  const onMissingKey: string = options.onMissingKey ?? 'generate';
  if (onMissingKey !== 'generate' && onMissingKey !== 'reject') {
    throw new IdempotixConfigurationError(
      'onMissingKey',
      `expected "generate" or "reject", got "${onMissingKey}"`,
    );
  }
  if (options.keyHeader?.trim().length === 0) {
    throw new IdempotixConfigurationError('keyHeader', 'must not be empty');
  }
  return {
    store: options.store,
    ttlMs: parseDuration('ttl', options.ttl ?? DEFAULT_TTL),
    lockTtlMs: parseDuration('lockTtl', options.lockTtl ?? DEFAULT_LOCK_TTL),
    keyExtractor: options.keyExtractor ?? headerExtractor(options.keyHeader ?? DEFAULT_KEY_HEADER),
    onMissingKey,
    tenant: options.tenant ?? (() => null),
    runInTransaction: options.runInTransaction ?? ((fn) => fn()),
    metrics: options.metrics ?? new NoopMetrics(),
    clock: options.clock ?? new SystemClock(),
  };
}
