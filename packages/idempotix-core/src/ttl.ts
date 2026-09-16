import { InvalidTtlError } from './errors.js';

const UNIT_MS = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type TtlUnit = keyof typeof UNIT_MS;

function isTtlUnit(value: string): value is TtlUnit {
  return value in UNIT_MS;
}

const TTL_PATTERN = /^(?<amount>\d+)(?<unit>s|m|h|d)$/;

export function parseTtlMs(input: string): number {
  const match = TTL_PATTERN.exec(input.trim());
  const amount = match?.groups?.['amount'];
  const unit = match?.groups?.['unit'];
  if (!amount || !unit || !isTtlUnit(unit)) {
    throw new InvalidTtlError(input);
  }
  return Number(amount) * UNIT_MS[unit];
}
