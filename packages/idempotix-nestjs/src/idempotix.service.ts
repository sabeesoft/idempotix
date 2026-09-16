import { Inject, Injectable } from '@nestjs/common';
import { buildScope, runIdempotent, type JsonValue } from '@sabeesoft/idempotix-core';
import { IDEMPOTIX_OPTIONS, parseDuration, type ResolvedIdempotixOptions } from './options.js';

export interface IdempotentRunInput<T extends JsonValue> {
  /** The idempotency key for this block. Derive per block when a request has several, e.g. `${key}:ledger-debit`. */
  key: string;
  /** Low-cardinality operation name used for scoping and metrics, e.g. `"ledger.debit"`. Never a raw URL or id. */
  route: string;
  tenant?: string | null;
  /** Whatever identifies "the same request" — fingerprinted to detect key reuse with a different payload. */
  payload: unknown;
  ttl?: string;
  lockTtl?: string;
  handler: () => Promise<T>;
}

export interface IdempotentRunResult<T extends JsonValue> {
  replayed: boolean;
  value: T;
}

/**
 * Explicit, callback-style idempotency for flows that manage their own
 * transaction boundary, need several idempotent blocks in one request, or
 * must keep long-running external calls outside the guarded section.
 *
 * This service never opens a transaction itself. Keep the acquire and the
 * business write inside one transaction of your own; if you commit a
 * `processing` record before completing it, a reclaim after `lockTtl` can
 * race the original writer.
 */
@Injectable()
export class IdempotixService {
  constructor(@Inject(IDEMPOTIX_OPTIONS) private readonly options: ResolvedIdempotixOptions) {}

  async run<T extends JsonValue>(input: IdempotentRunInput<T>): Promise<IdempotentRunResult<T>> {
    const { options } = this;
    const result = await runIdempotent({
      store: options.store,
      metrics: options.metrics,
      clock: options.clock,
      scope: buildScope({ tenant: input.tenant, route: input.route }),
      key: input.key,
      route: input.route,
      payload: input.payload,
      ttlMs: input.ttl ? parseDuration('ttl', input.ttl) : options.ttlMs,
      lockDurationMs: input.lockTtl ? parseDuration('lockTtl', input.lockTtl) : options.lockTtlMs,
      handler: async () => ({ responseCode: 200, responseBody: await input.handler() }),
    });
    return { replayed: result.replayed, value: result.responseBody as T };
  }
}
