import { randomUUID } from 'node:crypto';

export function generateKey(): string {
  return randomUUID();
}
