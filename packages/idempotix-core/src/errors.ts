export abstract class IdempotixError extends Error {
  abstract readonly code: string;
}

export class FingerprintMismatchError extends IdempotixError {
  readonly code = 'FINGERPRINT_MISMATCH';

  constructor(
    public readonly scope: string,
    public readonly key: string,
  ) {
    super(`Idempotency key "${key}" was already used with a different request payload`);
    this.name = 'FingerprintMismatchError';
  }
}

export class ConflictInProgressError extends IdempotixError {
  readonly code = 'CONFLICT_IN_PROGRESS';

  constructor(
    public readonly scope: string,
    public readonly key: string,
    public readonly retryAfterMs: number,
  ) {
    super(`Idempotency key "${key}" is still being processed`);
    this.name = 'ConflictInProgressError';
  }
}

export class UnsupportedPayloadValueError extends IdempotixError {
  readonly code = 'UNSUPPORTED_PAYLOAD_VALUE';

  constructor(
    public readonly path: string,
    public readonly valueType: string,
  ) {
    super(`Cannot fingerprint payload: unsupported value of type "${valueType}" at "${path}"`);
    this.name = 'UnsupportedPayloadValueError';
  }
}

export class InvalidTtlError extends IdempotixError {
  readonly code = 'INVALID_TTL';

  constructor(public readonly input: string) {
    super(`Invalid TTL string: "${input}"`);
    this.name = 'InvalidTtlError';
  }
}

export class InvalidScopePartError extends IdempotixError {
  readonly code = 'INVALID_SCOPE_PART';

  constructor(public readonly part: 'tenant' | 'route') {
    super(`Scope "${part}" must not contain the U+001F unit separator character`);
    this.name = 'InvalidScopePartError';
  }
}
