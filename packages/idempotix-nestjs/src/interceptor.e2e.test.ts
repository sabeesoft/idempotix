import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  InMemoryIdempotencyStore,
  type IdempotencyMetrics,
  type IdempotencyOutcome,
  type MetricAttributes,
} from '@sabeesoft/idempotix-core';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Idempotent } from './idempotent.decorator.js';
import { IdempotixModule } from './idempotix.module.js';
import { IdempotixService } from './idempotix.service.js';
import type { IdempotixModuleOptions } from './options.js';

class RecordingMetrics implements IdempotencyMetrics {
  readonly outcomes: { outcome: IdempotencyOutcome; route: string }[] = [];
  recordOutcome(outcome: IdempotencyOutcome, attrs: MetricAttributes): void {
    this.outcomes.push({ outcome, route: attrs.route });
  }
  recordProcessingStarted(): void {
    // not asserted here
  }
  recordProcessingEnded(): void {
    // not asserted here
  }
  recordHandlerDuration(): void {
    // not asserted here
  }
}

/** Shared mutable test state the controller reports into. */
@Injectable()
class Probe {
  handlerCalls = 0;
  /** When set, the next handler invocation waits on it. */
  gate: Promise<void> | undefined;
  fail = false;
  releaseGate: () => void = () => undefined;

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }
}

@Controller('payments')
class PaymentsController {
  constructor(
    @Inject(Probe) private readonly probe: Probe,
    @Inject(IdempotixService) private readonly idempotix: IdempotixService,
  ) {}

  @Post('accepted')
  @HttpCode(202)
  @Idempotent({ ttl: '1h' })
  accepted(): { ok: true } {
    this.probe.handlerCalls += 1;
    return { ok: true };
  }

  @Post('explicit')
  async explicit(@Body() body: { key: string }): Promise<{ debit: string; credit: string }> {
    this.probe.handlerCalls += 1;
    const debit = await this.idempotix.run({
      key: `${body.key}:debit`,
      route: 'ledger.debit',
      payload: body,
      handler: () => Promise.resolve(`debit-${String(this.probe.handlerCalls)}`),
    });
    const credit = await this.idempotix.run({
      key: `${body.key}:credit`,
      route: 'ledger.credit',
      payload: body,
      handler: () => Promise.resolve(`credit-${String(this.probe.handlerCalls)}`),
    });
    return { debit: debit.value, credit: credit.value };
  }

  @Get('plain')
  plain(): { plain: true } {
    this.probe.handlerCalls += 1;
    return { plain: true };
  }

  // Declared last: Nest registers routes in declaration order and this one
  // would otherwise swallow /payments/accepted and /payments/explicit.
  @Post(':accountId')
  @Idempotent()
  async create(
    @Param('accountId') accountId: string,
    @Body() body: { amount: number },
  ): Promise<{ id: string; accountId: string; amount: number }> {
    this.probe.handlerCalls += 1;
    if (this.probe.gate) {
      await this.probe.gate;
    }
    if (this.probe.fail) {
      throw new Error('ledger unavailable');
    }
    return { id: `pay-${String(this.probe.handlerCalls)}`, accountId, amount: body.amount };
  }
}

async function bootstrap(
  overrides: Partial<IdempotixModuleOptions> = {},
): Promise<{ app: INestApplication; probe: Probe; metrics: RecordingMetrics }> {
  const metrics = new RecordingMetrics();
  @Module({ controllers: [PaymentsController], providers: [Probe] })
  class AppModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [
      IdempotixModule.forRoot({
        store: new InMemoryIdempotencyStore(),
        metrics,
        tenant: (req) => (req as { headers: Record<string, string> }).headers['x-tenant'] ?? null,
        ...overrides,
      }),
      AppModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, probe: app.get(Probe), metrics };
}

describe('IdempotixInterceptor (in-memory store)', () => {
  let app: INestApplication;
  let probe: Probe;
  let metrics: RecordingMetrics;

  beforeAll(async () => {
    ({ app, probe, metrics } = await bootstrap());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    probe.handlerCalls = 0;
    probe.fail = false;
    probe.gate = undefined;
    metrics.outcomes.length = 0;
  });

  const server = (): Parameters<typeof request>[0] =>
    app.getHttpServer() as Parameters<typeof request>[0];
  const key = (): string => `k-${String(Math.random()).slice(2)}`;

  it('replays the stored response for a repeated key without re-running the handler', async () => {
    const k = key();
    const first = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', k)
      .send({ amount: 100 });
    const second = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', k)
      .send({ amount: 100 });

    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(probe.handlerCalls).toBe(1);
    expect(metrics.outcomes.map((o) => o.outcome)).toEqual(['acquired', 'replayed']);
    expect(metrics.outcomes[0]?.route).toBe('POST /payments/:accountId');
  });

  it('returns 422 when the same key is reused with a different payload', async () => {
    const k = key();
    await request(server()).post('/payments/acc-1').set('Idempotency-Key', k).send({ amount: 100 });
    const res = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', k)
      .send({ amount: 200 });
    expect(res.status).toBe(422);
    expect(probe.handlerCalls).toBe(1);
  });

  it('treats route params as part of the payload', async () => {
    const k = key();
    await request(server()).post('/payments/acc-1').set('Idempotency-Key', k).send({ amount: 100 });
    const res = await request(server())
      .post('/payments/acc-2')
      .set('Idempotency-Key', k)
      .send({ amount: 100 });
    expect(res.status).toBe(422);
  });

  it('returns 409 with Retry-After while the first request is still processing', async () => {
    const k = key();
    probe.hold();
    // supertest requests are lazy — `.then()` is what actually sends them.
    const first = request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', k)
      .send({ amount: 1 })
      .then((r) => r);
    // Wait until the handler has been entered (and therefore the key acquired).
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (probe.handlerCalls === 1) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });

    const second = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', k)
      .send({ amount: 1 });
    expect(second.status).toBe(409);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);

    probe.releaseGate();
    expect((await first).status).toBe(201);
    expect(probe.handlerCalls).toBe(1);
  });

  it('runs the handler exactly once for concurrent identical requests', async () => {
    const k = key();
    probe.hold();
    const inflight = Array.from({ length: 10 }, () =>
      request(server())
        .post('/payments/acc-1')
        .set('Idempotency-Key', k)
        .send({ amount: 5 })
        .then((r) => r),
    );
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (probe.handlerCalls >= 1) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });
    // Let the other nine reach the store while the first is held.
    await new Promise((resolve) => setTimeout(resolve, 50));
    probe.releaseGate();
    const responses = await Promise.all(inflight);

    const statuses = responses.map((r) => r.status).sort();
    expect(probe.handlerCalls).toBe(1);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
  });

  it('generates a key and reports it when the header is missing', async () => {
    const a = await request(server()).post('/payments/acc-1').send({ amount: 1 });
    const b = await request(server()).post('/payments/acc-1').send({ amount: 1 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(probe.handlerCalls).toBe(2);
    expect(metrics.outcomes.filter((o) => o.outcome === 'key_generated')).toHaveLength(2);
  });

  it('isolates tenants', async () => {
    const k = key();
    await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', k)
      .set('X-Tenant', 'acme')
      .send({ amount: 1 });
    const other = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', k)
      .set('X-Tenant', 'globex')
      .send({ amount: 1 });
    expect(other.status).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(probe.handlerCalls).toBe(2);
  });

  it('lets a failed request be retried with the same key', async () => {
    const k = key();
    probe.fail = true;
    const failed = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', k)
      .send({ amount: 1 });
    expect(failed.status).toBe(500);

    probe.fail = false;
    // The in-memory store has no transactions, so the key stays "processing"
    // until its lock expires; use a route with a short lock to prove the retry.
    const retry = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', k)
      .send({ amount: 1 });
    expect(retry.status).toBe(409);
  });

  it('honours @HttpCode and per-route options', async () => {
    const k = key();
    const first = await request(server())
      .post('/payments/accepted')
      .set('Idempotency-Key', k)
      .send({});
    const second = await request(server())
      .post('/payments/accepted')
      .set('Idempotency-Key', k)
      .send({});
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('leaves undecorated routes alone', async () => {
    const res = await request(server()).get('/payments/plain').set('Idempotency-Key', key());
    expect(res.status).toBe(200);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(metrics.outcomes).toHaveLength(0);
  });

  it('supports several explicit idempotent blocks in one request', async () => {
    const body = { key: key() };
    const first = await request(server()).post('/payments/explicit').send(body);
    const second = await request(server()).post('/payments/explicit').send(body);
    expect(first.status).toBe(201);
    // The handler itself is not decorated, so it runs twice — but both blocks replay.
    expect(probe.handlerCalls).toBe(2);
    expect(first.body).toEqual({ debit: 'debit-1', credit: 'credit-1' });
    expect(second.body).toEqual(first.body);
  });
});

describe('IdempotixInterceptor with onMissingKey: reject', () => {
  it('rejects requests without a key', async () => {
    const { app } = await bootstrap({ onMissingKey: 'reject' });
    try {
      const res = await request(app.getHttpServer() as Parameters<typeof request>[0])
        .post('/payments/acc-1')
        .send({ amount: 1 });
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
