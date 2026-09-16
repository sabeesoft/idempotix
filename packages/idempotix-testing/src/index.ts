/**
 * @sabeesoft/idempotix-testing
 *
 * Shared, runner-agnostic contract test suite for `IdempotencyStore`
 * implementations. Every adapter — Prisma, TypeORM, in-memory, third-party —
 * must pass it unchanged.
 */

export type { StoreContractOptions, TestRunner } from './contract.js';
export { runStoreContractSuite } from './contract.js';
