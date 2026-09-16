import { readFileSync } from 'node:fs';
import {
  Body,
  Controller,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsPluginTransactional, TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { Idempotent, IdempotixModule } from '@sabeesoft/idempotix-nestjs';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ClsModule } from 'nestjs-cls';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from './generated/prisma/client.js';
import { createPrismaIdempotencyStore } from './store.js';
import {
  containerRuntimeAvailable,
  warnNoContainerRuntime,
} from './test-support/container-runtime.js';

const PRISMA = Symbol('PRISMA');

/**
 * The transaction host, typed for the generated Prisma 7 client. Under strict
 * settings `TTxFromAdapter` cannot see through the generated client's
 * `$transaction` overloads and infers `tx` as `never`, so `tx` is read through
 * a typed accessor instead of the raw getter.
 */
type Host = TransactionHost<TransactionalAdapterPrisma<PrismaClient>>;
const txOf = (host: Host): Prisma.TransactionClient => host.tx as Prisma.TransactionClient;

@Injectable()
class Probe {
  handlerCalls = 0;
}

/**
 * A realistic handler: one business write through the app's own transaction
 * client, then either success or a failure that must roll everything back.
 */
@Controller('payments')
class PaymentsController {
  constructor(
    @Inject(TransactionHost) private readonly host: Host,
    @Inject(Probe) private readonly probe: Probe,
  ) {}

  @Post(':accountId')
  @Idempotent()
  async create(
    @Param('accountId') accountId: string,
    @Body() body: { amount: number; fail?: boolean; slowMs?: number },
  ): Promise<{ accountId: string; amount: number }> {
    this.probe.handlerCalls += 1;
    await txOf(this.host).$executeRawUnsafe(
      'INSERT INTO test_payments (account_id, amount) VALUES ($1, $2)',
      accountId,
      body.amount,
    );
    if (body.slowMs) {
      await txOf(this.host).$executeRawUnsafe(`SELECT pg_sleep(${String(body.slowMs / 1000)})`);
    }
    if (body.fail) {
      throw new Error('ledger unavailable');
    }
    return { accountId, amount: body.amount };
  }
}

const runtimeAvailable = containerRuntimeAvailable();
if (!runtimeAvailable) {
  warnNoContainerRuntime('the NestJS full-stack e2e suite');
}

describe.skipIf(!runtimeAvailable)('NestJS + @nestjs-cls/transactional + Prisma + Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let prisma: PrismaClient;
  let app: INestApplication;
  let probe: Probe;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const migration = readFileSync(
      new URL('../prisma/migration.sql', import.meta.url),
      'utf8',
    ).replace(/^\s*--.*$/gm, '');
    for (const statement of migration.split(';').filter((s) => s.trim().length > 0)) {
      await prisma.$executeRawUnsafe(statement);
    }
    await prisma.$executeRawUnsafe(
      'CREATE TABLE test_payments (id serial PRIMARY KEY, account_id text NOT NULL, amount integer NOT NULL)',
    );

    @Module({ providers: [{ provide: PRISMA, useValue: prisma }], exports: [PRISMA] })
    class PrismaModule {}

    @Module({ controllers: [PaymentsController], providers: [Probe] })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({
          middleware: { mount: true },
          plugins: [
            new ClsPluginTransactional({
              imports: [PrismaModule],
              // The adapter's optional fields aren't declared `| undefined`, which
              // this repo's exactOptionalPropertyTypes rejects; apps normally don't
              // enable that flag.
              adapter: new TransactionalAdapterPrisma<PrismaClient>({
                prismaInjectionToken: PRISMA,
              }) as ConstructorParameters<typeof ClsPluginTransactional>[0]['adapter'],
            }),
          ],
        }),
        // The three lines that wire idempotix into the app's own transaction.
        IdempotixModule.forRootAsync({
          inject: [TransactionHost],
          useFactory: (host: Host) => ({
            store: createPrismaIdempotencyStore({ client: () => txOf(host) }),
            runInTransaction: (fn) => host.withTransaction(fn),
          }),
        }),
        AppModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    probe = app.get(Probe);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await container.stop();
  });

  const server = (): Parameters<typeof request>[0] =>
    app.getHttpServer() as Parameters<typeof request>[0];

  async function count(table: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM ${table}`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  it('rolls back both the business write and the key when the handler fails, then allows a retry and replays it', async () => {
    const key = 'pay-1';

    const failed = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', key)
      .send({ amount: 100, fail: true });
    expect(failed.status).toBe(500);
    expect(await count('test_payments')).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);

    const retry = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', key)
      .send({ amount: 100 });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await count('test_payments')).toBe(1);
    expect(await count('idempotency_keys')).toBe(1);

    const replay = await request(server())
      .post('/payments/acc-1')
      .set('Idempotency-Key', key)
      .send({ amount: 100 });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(retry.body);
    expect(await count('test_payments')).toBe(1);
    expect(probe.handlerCalls).toBe(2);
  });

  it('serialises concurrent duplicates on the row lock: one write, everyone gets the same response', async () => {
    probe.handlerCalls = 0;
    const key = 'pay-concurrent';
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(server())
          .post('/payments/acc-2')
          .set('Idempotency-Key', key)
          .send({ amount: 7, slowMs: 300 })
          .then((r) => r),
      ),
    );

    // Postgres blocks the other INSERT ... ON CONFLICT statements on the first
    // transaction's row lock until it commits, after which they see a completed
    // key and replay — no 409s, no duplicate writes.
    expect(probe.handlerCalls).toBe(1);
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
    // jsonb does not preserve key order, so compare structurally, not as strings.
    for (const response of responses) {
      expect(response.body).toEqual({ accountId: 'acc-2', amount: 7 });
    }
    expect(await count('test_payments')).toBe(2);
  });
});
