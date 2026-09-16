import { BadRequestException, Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { IdempotixService } from '@sabeesoft/idempotix-nestjs';
import { LedgerService, type Host } from './ledger.service.js';

interface TransferBody {
  from: string;
  to: string;
  amount: number;
}

/**
 * Explicit mode: two idempotent blocks (debit, credit) inside one transaction
 * the controller opens itself. Each block has its own derived key, so a retry
 * after a partial failure replays what already completed and only runs the
 * rest — while the outer transaction still guarantees all-or-nothing per attempt.
 */
@Controller('transfers')
export class TransfersController {
  constructor(
    @Inject(IdempotixService) private readonly idempotix: IdempotixService,
    @Inject(TransactionHost) private readonly host: Host,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  @Post()
  transfer(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: TransferBody,
  ): Promise<{ debit: number; credit: number; replayed: boolean }> {
    if (!key) {
      throw new BadRequestException('Idempotency-Key header is required for transfers');
    }
    return this.host.withTransaction(async () => {
      const debit = await this.idempotix.run({
        key: `${key}:debit`,
        route: 'transfers.debit',
        payload: body,
        handler: async () => (await this.ledger.post(body.from, -body.amount)).id,
      });
      const credit = await this.idempotix.run({
        key: `${key}:credit`,
        route: 'transfers.credit',
        payload: body,
        handler: async () => (await this.ledger.post(body.to, body.amount)).id,
      });
      return {
        debit: debit.value,
        credit: credit.value,
        replayed: debit.replayed && credit.replayed,
      };
    });
  }
}
