import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ConflictInProgressError,
  FingerprintMismatchError,
  buildScope,
  generateKey,
  runIdempotent,
  type JsonValue,
} from '@sabeesoft/idempotix-core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { Idempotent } from './idempotent.decorator.js';
import { IDEMPOTIX_OPTIONS, parseDuration, type ResolvedIdempotixOptions } from './options.js';
import { routeTemplate, statusCodeFor } from './route.js';

export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

interface HttpRequestLike {
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

interface HttpResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** The stored copy is exactly what the client received: plain JSON. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

@Injectable()
export class IdempotixInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTIX_OPTIONS) private readonly options: ResolvedIdempotixOptions,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const routeOptions = this.reflector.getAllAndOverride(Idempotent, [
      context.getHandler(),
      context.getClass(),
    ]);
    // `getAllAndOverride` returns undefined both for "not decorated" and for
    // `@Idempotent()` without options, so check the decorator's presence via
    // the metadata key list instead of the value.
    const decorated = [context.getHandler(), context.getClass()].some((target) =>
      Reflect.hasMetadata(Idempotent.KEY, target),
    );
    if (!decorated || context.getType() !== 'http') {
      return next.handle();
    }
    return from(this.run(context, next, routeOptions ?? {}));
  }

  private async run(
    context: ExecutionContext,
    next: CallHandler,
    routeOptions: { ttl?: string; lockTtl?: string; route?: string },
  ): Promise<unknown> {
    const { options } = this;
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();
    const route = routeTemplate(context, routeOptions.route);

    let key = options.keyExtractor(request);
    if (key === undefined) {
      if (options.onMissingKey === 'reject') {
        throw new BadRequestException('Missing idempotency key');
      }
      key = generateKey();
      options.metrics.recordOutcome('key_generated', { route });
    }

    const scope = buildScope({ tenant: options.tenant(request), route });
    const ttlMs = routeOptions.ttl ? parseDuration('ttl', routeOptions.ttl) : options.ttlMs;
    const lockDurationMs = routeOptions.lockTtl
      ? parseDuration('lockTtl', routeOptions.lockTtl)
      : options.lockTtlMs;
    const responseCode = statusCodeFor(context);

    try {
      const result = await this.inTransaction(route, () =>
        runIdempotent({
          store: options.store,
          metrics: options.metrics,
          clock: options.clock,
          scope,
          key,
          route,
          payload: { params: request.params, query: request.query, body: request.body },
          ttlMs,
          lockDurationMs,
          handler: async () => ({
            responseCode,
            responseBody: toJson(await lastValueFrom(next.handle(), { defaultValue: undefined })),
          }),
        }),
      );
      if (result.replayed) {
        response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        response.status(result.responseCode);
      }
      return result.responseBody;
    } catch (err) {
      if (err instanceof FingerprintMismatchError) {
        throw new UnprocessableEntityException(
          'Idempotency key was already used with a different request payload',
        );
      }
      if (err instanceof ConflictInProgressError) {
        response.setHeader('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
        throw new ConflictException('A request with this idempotency key is still being processed');
      }
      throw err;
    }
  }

  /** Runs `fn` through the app's transaction runner, if configured, and records the outcome. */
  private async inTransaction<R>(route: string, fn: () => Promise<R>): Promise<R> {
    const { runInTransaction, metrics, clock } = this.options;
    if (!runInTransaction) {
      return fn();
    }
    const start = clock.now().getTime();
    const seconds = (): number => (clock.now().getTime() - start) / 1000;
    try {
      const result = await runInTransaction(fn);
      metrics.recordTransaction(seconds(), { route, outcome: 'commit' });
      return result;
    } catch (err) {
      metrics.recordTransaction(seconds(), {
        route,
        outcome: 'rollback',
        errorType: errorType(err),
      });
      throw err;
    }
  }
}

/** A bounded identifier for an error: its `code` (e.g. a driver error code) or class name. */
function errorType(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) {
      return name;
    }
  }
  return 'Error';
}
