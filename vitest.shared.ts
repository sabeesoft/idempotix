import { defineConfig } from 'vitest/config';

export const sharedVitestConfig = defineConfig({
  test: {
    environment: 'node',
    globals: false,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
