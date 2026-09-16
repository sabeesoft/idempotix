import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { Idempotent } from '@sabeesoft/idempotix-nestjs';
import { LedgerService, type PaymentRecord } from './ledger.service.js';

interface CreatePaymentBody {
  amount: number;
  /** Simulates slow work so a concurrent duplicate can be observed (409 / replay). */
  delayMs?: number;
  /** Simulates a business failure after the write, to see the rollback. */
  fail?: boolean;
}

@Controller('accounts/:accountId')
export class PaymentsController {
  constructor(@Inject(LedgerService) private readonly ledger: LedgerService) {}

  @Post()
  async create(@Param('accountId') accountId: string): Promise<{ id: string }> {
    await this.ledger.ensureAccount(accountId);
    return { id: accountId };
  }

  /**
   * Idempotent: send an `Idempotency-Key` header. The payment row, the balance
   * update and the idempotency record commit — or roll back — together.
   */
  @Post('payments')
  @Idempotent({ ttl: '1h' })
  async pay(
    @Param('accountId') accountId: string,
    @Body() body: CreatePaymentBody,
  ): Promise<PaymentRecord> {
    const payment = await this.ledger.post(accountId, body.amount);
    if (body.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, body.delayMs));
    }
    if (body.fail) {
      throw new Error('simulated downstream failure');
    }
    return payment;
  }

  @Get('payments')
  list(@Param('accountId') accountId: string): ReturnType<LedgerService['list']> {
    return this.ledger.list(accountId);
  }
}
