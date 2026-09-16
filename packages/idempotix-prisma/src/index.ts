/**
 * @sabeesoft/idempotix-prisma
 *
 * Prisma 7 / PostgreSQL store adapter for idempotix. Query, transaction and
 * pool instrumentation follow in a later milestone.
 */

export type { PrismaIdempotencyStoreOptions, PrismaRawClient } from './store.js';
export { createPrismaIdempotencyStore } from './store.js';
