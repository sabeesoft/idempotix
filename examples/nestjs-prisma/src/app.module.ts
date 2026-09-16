import { Module } from '@nestjs/common';
import { ClsPluginTransactional, TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { IdempotixModule } from '@sabeesoft/idempotix-nestjs';
import { createPrismaIdempotencyStore } from '@sabeesoft/idempotix-prisma';
import { ClsModule } from 'nestjs-cls';
import { DatabaseModule, PRISMA, type Tx } from './database.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { LedgerService, type Host } from './ledger.service.js';
import { PaymentsController } from './payments.controller.js';
import { TransfersController } from './transfers.controller.js';

@Module({
  imports: [
    DatabaseModule,
    ClsModule.forRoot({
      middleware: { mount: true },
      plugins: [
        new ClsPluginTransactional({
          imports: [DatabaseModule],
          adapter: new TransactionalAdapterPrisma<PrismaClient>({
            prismaInjectionToken: PRISMA,
            // Interactive-transaction limits; visible as error.type=P2028 on timeout.
            defaultTxOptions: { maxWait: 2_000, timeout: 5_000 },
          }) as ConstructorParameters<typeof ClsPluginTransactional>[0]['adapter'],
        }),
      ],
    }),
    // The idempotix wiring: the store uses the request's transaction client,
    // and every guarded handler runs inside host.withTransaction.
    IdempotixModule.forRootAsync({
      inject: [TransactionHost],
      useFactory: (host: Host) => ({
        store: createPrismaIdempotencyStore({ client: () => host.tx as Tx }),
        runInTransaction: (fn) => host.withTransaction(fn),
        ttl: '24h',
        lockTtl: '60s',
        tenant: (req) =>
          (req as { headers: Record<string, string | undefined> }).headers['x-tenant'] ?? null,
      }),
    }),
  ],
  controllers: [PaymentsController, TransfersController],
  providers: [LedgerService],
})
export class AppModule {}
