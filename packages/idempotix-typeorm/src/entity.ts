import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { JsonValue } from '@sabeesoft/idempotix-core';

/**
 * Reference entity for the idempotency table. Every column type is explicit so
 * no `emitDecoratorMetadata` is needed. Register it if your app manages the
 * schema through TypeORM (`entities`, `synchronize`, migrations); otherwise
 * apply `migration.sql` with your own tooling. The store itself never uses
 * the entity — it speaks raw SQL through your `EntityManager`.
 */
@Entity({ name: 'idempotency_keys' })
@Index('idempotency_keys_locked_until_idx', ['lockedUntil'])
export class IdempotencyKeyEntity {
  @PrimaryColumn({ type: 'text' })
  scope!: string;

  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'text', name: 'request_hash' })
  requestHash!: string;

  /** `'processing'` | `'completed'` */
  @Column({ type: 'text' })
  status!: string;

  @Column({ type: 'integer', name: 'response_code', nullable: true })
  responseCode!: number | null;

  @Column({ type: 'jsonb', name: 'response_body', nullable: true })
  responseBody!: JsonValue | null;

  /** Lock expiry while processing; replay-retention expiry once completed. */
  @Column({ type: 'timestamptz', name: 'locked_until', precision: 3 })
  lockedUntil!: Date;

  @Column({ type: 'timestamptz', name: 'created_at', precision: 3, default: () => 'now()' })
  createdAt!: Date;
}
