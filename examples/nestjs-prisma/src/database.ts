import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { instrumentPrisma } from '@sabeesoft/idempotix-prisma';
import pg from 'pg';
import { PrismaClient, type Prisma } from './generated/prisma/client.js';

export const PRISMA = Symbol('PRISMA');

/** Owns the pg pool and the (instrumented) Prisma client for the app's lifetime. */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: pg.Pool;
  readonly client: PrismaClient;
  private readonly dispose: () => void;

  constructor() {
    this.pool = new pg.Pool({
      connectionString:
        process.env['DATABASE_URL'] ?? 'postgresql://idempotix:idempotix@localhost:5432/idempotix',
      max: 10,
    });
    const instrumented = instrumentPrisma({
      client: new PrismaClient({ adapter: new PrismaPg(this.pool) }),
      pool: this.pool,
      poolName: 'primary',
    });
    this.client = instrumented.client;
    this.dispose = instrumented.dispose;
  }

  async onModuleDestroy(): Promise<void> {
    this.dispose();
    await this.client.$disconnect();
    await this.pool.end();
  }
}

@Module({
  providers: [
    Database,
    { provide: PRISMA, useFactory: (db: Database) => db.client, inject: [Database] },
  ],
  exports: [PRISMA, Database],
})
export class DatabaseModule {}

/** The transaction client type for handlers; see the nestjs README on why `tx` is cast. */
export type Tx = Prisma.TransactionClient;
