import { InvalidScopePartError } from './errors.js';

/** ASCII unit separator (code point 31 / U+001F) — a control character that can't appear in normal tenant ids or route templates. */
const SEPARATOR = String.fromCharCode(31);
const DEFAULT_TENANT = '_';

export interface ScopeParts {
  tenant?: string | null;
  route: string;
}

export function buildScope(parts: ScopeParts): string {
  const trimmedTenant = parts.tenant?.trim();
  // Not `??`: an empty-after-trim tenant (e.g. "   ") must also fall back to
  // the default, and `??` only catches null/undefined, not empty string.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const tenant = trimmedTenant ? trimmedTenant : DEFAULT_TENANT;
  if (tenant.includes(SEPARATOR)) {
    throw new InvalidScopePartError('tenant');
  }
  if (parts.route.includes(SEPARATOR)) {
    throw new InvalidScopePartError('route');
  }
  return `${tenant}${SEPARATOR}${parts.route}`;
}
