import { mergeConfig, defineConfig } from 'vitest/config';
import { sharedVitestConfig } from '../../vitest.shared.ts';

export default mergeConfig(
  sharedVitestConfig,
  defineConfig({ test: { name: 'idempotix-nestjs' } }),
);
