import type { JsonValue } from './fingerprint.js';

export type IdempotencyStatus = 'processing' | 'completed';

interface IdempotencyRecordBase {
  scope: string;
  key: string;
  requestHash: string;
  lockedUntil: Date;
  createdAt: Date;
}

/**
 * A discriminated union on `status` so a `status === 'completed'` check
 * narrows `responseCode`/`responseBody` to non-null without a type assertion.
 */
export type IdempotencyRecord =
  | (IdempotencyRecordBase & { status: 'processing'; responseCode: null; responseBody: null })
  | (IdempotencyRecordBase & {
      status: 'completed';
      responseCode: number;
      responseBody: JsonValue;
    });

export interface TryAcquireInput {
  scope: string;
  key: string;
  requestHash: string;
  now: Date;
  lockDurationMs: number;
}

export type TryAcquireResult =
  { outcome: 'acquired'; reclaimed: boolean } | { outcome: 'conflict' };

export interface FindForUpdateInput {
  scope: string;
  key: string;
}

export interface MarkCompletedInput {
  scope: string;
  key: string;
  responseCode: number;
  responseBody: JsonValue;
  now: Date;
  ttlMs: number;
}

export interface PurgeExpiredInput {
  now: Date;
}

/**
 * Adapter contract every ORM-specific store (Prisma, TypeORM, ...) implements.
 * Methods take plain domain inputs/outputs only — no DB client or transaction
 * parameter — because resolving "the currently active transactional client"
 * is the concrete adapter's job (e.g. via nestjs-cls), not core's concern.
 */
export interface IdempotencyStore {
  tryAcquire(input: TryAcquireInput): Promise<TryAcquireResult>;
  findForUpdate(input: FindForUpdateInput): Promise<IdempotencyRecord | null>;
  markCompleted(input: MarkCompletedInput): Promise<void>;
  purgeExpired(input: PurgeExpiredInput): Promise<number>;
}
