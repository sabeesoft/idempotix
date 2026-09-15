import { defineConfig, type Options } from 'tsup';

export function createTsupConfig(overrides: Options = {}) {
  return defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    target: 'node24',
    platform: 'node',
    outDir: 'dist',
    ...overrides,
  });
}
