import { createHash } from 'node:crypto';
import { UnsupportedPayloadValueError } from './errors.js';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown, path: string): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (value instanceof Map || value instanceof Set || value instanceof RegExp) {
    throw new UnsupportedPayloadValueError(path, value.constructor.name);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const result: Record<string, JsonValue> = {};
    for (const key of keys) {
      result[key] = canonicalize(record[key], `${path}.${key}`);
    }
    return result;
  }
  throw new UnsupportedPayloadValueError(path, typeof value);
}

export function fingerprint(payload: unknown): string {
  const canonical = canonicalize(payload, '$');
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}
