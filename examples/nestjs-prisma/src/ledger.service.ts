import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { PrismaClient } from './generated/prisma/client.js';
import type { Tx } from './database.js';

export type Host = TransactionHost<TransactionalAdapterPrisma<PrismaClient>>;

export interface PaymentRecord {
  id: number;
  accountId: string;
  amount: number;
  balanceAfter: number;
}

/**
 * All writes go through `host.tx`: inside an idempotent handler that is the
 * same transaction the idempotency record lives in, so a failure here rolls
 * both back together.
 */
@Injectable()
export class LedgerService {
  constructor(@Inject(TransactionHost) private readonly host: Host) {}

  private get tx(): Tx {
    return this.host.tx as Tx;
  }

  async ensureAccount(id: string): Promise<void> {
    await this.tx.account.upsert({ where: { id }, create: { id }, update: {} });
  }

  async post(accountId: string, amount: number): Promise<PaymentRecord> {
    const account = await this.tx.account.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException(`account ${accountId} does not exist`);
    }
    const payment = await this.tx.payment.create({ data: { accountId, amount } });
    const updated = await this.tx.account.update({
      where: { id: accountId },
      data: { balance: { increment: amount } },
    });
    return { id: payment.id, accountId, amount, balanceAfter: updated.balance };
  }

  list(accountId: string): Promise<{ id: number; amount: number; createdAt: Date }[]> {
    return this.tx.payment.findMany({
      where: { accountId },
      orderBy: { id: 'asc' },
      select: { id: true, amount: true, createdAt: true },
    });
  }
}
