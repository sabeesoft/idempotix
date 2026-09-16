import { Reflector } from '@nestjs/core';

export interface IdempotentOptions {
  /** Per-route replay-retention window, e.g. `'1h'`. Overrides the module default. */
  ttl?: string;
  /** Per-route processing-lock duration. Overrides the module default. */
  lockTtl?: string;
  /** Overrides the derived route template used for scoping and metrics. */
  route?: string;
}

/**
 * Marks a route handler as idempotent. Requests carrying the same
 * idempotency key (within the same tenant and route) are replayed from the
 * stored response instead of running the handler again.
 */
export const Idempotent = Reflector.createDecorator<IdempotentOptions | undefined>();
