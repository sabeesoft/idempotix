/**
 * `key_generated` is emitted by integrations when the caller supplied no key
 * and one was generated for them — the request ran, but with no real
 * idempotency protection against a retry.
 */
export type IdempotencyOutcome =
  'acquired' | 'reclaimed' | 'replayed' | 'conflict' | 'fingerprint_mismatch' | 'key_generated';

/**
 * Deliberately the only attribute shape metrics calls can accept: a
 * low-cardinality route *template* (e.g. "POST /payments/:id"). There is no
 * slot for scope, tenant, or the raw idempotency key — passing high-cardinality
 * data into a metric is a type error, not just a convention to remember.
 */
export interface MetricAttributes {
  route: string;
}

export interface IdempotencyMetrics {
  recordOutcome(outcome: IdempotencyOutcome, attrs: MetricAttributes): void;
  recordProcessingStarted(attrs: MetricAttributes): void;
  recordProcessingEnded(attrs: MetricAttributes): void;
  recordHandlerDuration(
    seconds: number,
    attrs: MetricAttributes & { outcome: 'success' | 'error' },
  ): void;
  /**
   * Emitted by integrations that run the guarded handler inside a transaction.
   * `errorType` is the thrown error's `code` or class name — a bounded set,
   * e.g. a driver's transaction-timeout code — never a message or an id.
   */
  recordTransaction(
    seconds: number,
    attrs: MetricAttributes & { outcome: 'commit' | 'rollback'; errorType?: string },
  ): void;
}

export class NoopMetrics implements IdempotencyMetrics {
  recordOutcome(): void {
    // no-op
  }

  recordProcessingStarted(): void {
    // no-op
  }

  recordProcessingEnded(): void {
    // no-op
  }

  recordHandlerDuration(): void {
    // no-op
  }

  recordTransaction(): void {
    // no-op
  }
}
