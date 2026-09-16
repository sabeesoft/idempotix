import type { JsonValue } from './fingerprint.js';
import type {
  FindForUpdateInput,
  IdempotencyRecord,
  IdempotencyStatus,
  IdempotencyStore,
  MarkCompletedInput,
  PurgeExpiredInput,
  TryAcquireInput,
  TryAcquireResult,
} from './store.js';

interface InternalRecord {
  scope: string;
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  // `undefined` means "not completed yet". `JsonValue` itself already
  // includes `null`, so a real completed response body can legitimately BE
  // `null` (e.g. a 204) — that must stay distinguishable from "unset".
  responseCode: number | undefined;
  responseBody: JsonValue | undefined;
  lockedUntil: Date;
  createdAt: Date;
}

function rowKey(scope: string, key: string): string {
  return `${scope}\0${key}`;
}

function toRecord(row: InternalRecord): IdempotencyRecord {
  const base = {
    scope: row.scope,
    key: row.key,
    requestHash: row.requestHash,
    lockedUntil: row.lockedUntil,
    createdAt: row.createdAt,
  };
  if (row.status === 'completed') {
    if (row.responseCode === undefined || row.responseBody === undefined) {
      throw new Error(
        `invariant violation: completed record for key "${row.key}" is missing its response`,
      );
    }
    return {
      ...base,
      status: 'completed',
      responseCode: row.responseCode,
      responseBody: row.responseBody,
    };
  }
  return { ...base, status: 'processing', responseCode: null, responseBody: null };
}

/**
 * Single-process reference implementation of {@link IdempotencyStore}, backed
 * by a Map. Every method body is synchronous internally (only wrapped in
 * `async` to satisfy the interface) so there is no `await` gap between
 * check-and-set — this matches the atomicity a real `INSERT ... ON CONFLICT`
 * gives, which matters when tests interleave concurrent calls via
 * `Promise.all`.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, InternalRecord>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async tryAcquire(input: TryAcquireInput): Promise<TryAcquireResult> {
    const id = rowKey(input.scope, input.key);
    const existing = this.rows.get(id);

    if (!existing) {
      this.rows.set(id, {
        scope: input.scope,
        key: input.key,
        requestHash: input.requestHash,
        status: 'processing',
        responseCode: undefined,
        responseBody: undefined,
        lockedUntil: new Date(input.now.getTime() + input.lockDurationMs),
        createdAt: input.now,
      });
      return { outcome: 'acquired', reclaimed: false };
    }

    const canReclaim =
      existing.status === 'processing' && existing.lockedUntil.getTime() <= input.now.getTime();
    if (!canReclaim) {
      return { outcome: 'conflict' };
    }

    existing.requestHash = input.requestHash;
    existing.status = 'processing';
    existing.responseCode = undefined;
    existing.responseBody = undefined;
    existing.lockedUntil = new Date(input.now.getTime() + input.lockDurationMs);
    return { outcome: 'acquired', reclaimed: true };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findForUpdate(input: FindForUpdateInput): Promise<IdempotencyRecord | null> {
    const row = this.rows.get(rowKey(input.scope, input.key));
    return row ? toRecord(row) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async markCompleted(input: MarkCompletedInput): Promise<void> {
    const row = this.rows.get(rowKey(input.scope, input.key));
    if (!row) {
      throw new Error(
        `markCompleted called for a record that does not exist (scope="${input.scope}", key="${input.key}")`,
      );
    }
    row.status = 'completed';
    row.responseCode = input.responseCode;
    row.responseBody = input.responseBody;
    row.lockedUntil = new Date(input.now.getTime() + input.ttlMs);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async purgeExpired(input: PurgeExpiredInput): Promise<number> {
    let purged = 0;
    for (const [id, row] of this.rows) {
      if (row.lockedUntil.getTime() < input.now.getTime()) {
        this.rows.delete(id);
        purged += 1;
      }
    }
    return purged;
  }
}
