import { InMemoryIdempotencyStore } from '@sabeesoft/idempotix-core';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { runStoreContractSuite } from './contract.js';

runStoreContractSuite('InMemoryIdempotencyStore', {
  runner: { describe, it, beforeEach, afterEach },
  createStore: () => new InMemoryIdempotencyStore(),
});
