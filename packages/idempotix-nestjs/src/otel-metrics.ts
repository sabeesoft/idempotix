import {
  metrics,
  type Counter,
  type Histogram,
  type MeterProvider,
  type UpDownCounter,
} from '@opentelemetry/api';
import type {
  IdempotencyMetrics,
  IdempotencyOutcome,
  MetricAttributes,
} from '@sabeesoft/idempotix-core';

export const IDEMPOTIX_METER_NAME = 'idempotix';
export const IDEMPOTIX_METER_VERSION = '0.0.0';

export interface OtelIdempotencyMetricsOptions {
  /** Defaults to the API's global provider — a no-op until an SDK registers one. */
  meterProvider?: MeterProvider;
}

/**
 * OpenTelemetry implementation of core's metrics port. Attribute values are
 * limited to the route template and bounded enums, so nothing this class
 * emits can carry an idempotency key, request id or tenant.
 */
export class OtelIdempotencyMetrics implements IdempotencyMetrics {
  private readonly requests: Counter;
  private readonly processing: UpDownCounter;
  private readonly handlerDuration: Histogram;
  private readonly transactionDuration: Histogram;

  constructor(options: OtelIdempotencyMetricsOptions = {}) {
    const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(
      IDEMPOTIX_METER_NAME,
      IDEMPOTIX_METER_VERSION,
    );
    this.requests = meter.createCounter('idempotix.requests', {
      description: 'Idempotent requests by outcome',
      unit: '{request}',
    });
    this.processing = meter.createUpDownCounter('idempotix.processing', {
      description: 'Requests currently holding an idempotency key in the processing state',
      unit: '{request}',
    });
    this.handlerDuration = meter.createHistogram('idempotix.handler.duration', {
      description: 'Duration of the guarded handler',
      unit: 's',
    });
    this.transactionDuration = meter.createHistogram('idempotix.transaction.duration', {
      description: 'Duration of the transaction wrapping the guarded handler',
      unit: 's',
    });
  }

  recordOutcome(outcome: IdempotencyOutcome, attrs: MetricAttributes): void {
    this.requests.add(1, { 'http.route': attrs.route, 'idempotix.outcome': outcome });
  }

  recordProcessingStarted(attrs: MetricAttributes): void {
    this.processing.add(1, { 'http.route': attrs.route });
  }

  recordProcessingEnded(attrs: MetricAttributes): void {
    this.processing.add(-1, { 'http.route': attrs.route });
  }

  recordHandlerDuration(
    seconds: number,
    attrs: MetricAttributes & { outcome: 'success' | 'error' },
  ): void {
    this.handlerDuration.record(seconds, {
      'http.route': attrs.route,
      'idempotix.result': attrs.outcome,
    });
  }

  recordTransaction(
    seconds: number,
    attrs: MetricAttributes & { outcome: 'commit' | 'rollback'; errorType?: string },
  ): void {
    this.transactionDuration.record(seconds, {
      'http.route': attrs.route,
      'idempotix.transaction.outcome': attrs.outcome,
      ...(attrs.errorType === undefined ? {} : { 'error.type': attrs.errorType }),
    });
  }
}
