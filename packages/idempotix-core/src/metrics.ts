export type IdempotencyOutcome =
  'acquired' | 'reclaimed' | 'replayed' | 'conflict' | 'fingerprint_mismatch';

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
}
