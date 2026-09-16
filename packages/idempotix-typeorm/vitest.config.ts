import { mergeConfig, defineConfig } from 'vitest/config';
import { sharedVitestConfig } from '../../vitest.shared.ts';

export default mergeConfig(
  sharedVitestConfig,
  defineConfig({
    test: {
      name: 'idempotix-typeorm',
      // Testcontainers has to pull and start Postgres on a cold machine.
      hookTimeout: 120_000,
      testTimeout: 30_000,
      coverage: { exclude: ['src/generated/**'] },
    },
  }),
);
