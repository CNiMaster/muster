import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@server': resolve(__dirname, 'src/server'),
    },
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['tests/unit/**/*.spec.tsx', 'jsdom']],
    include: [
      'tests/unit/**/*.{test,spec}.{ts,tsx}',
      'tests/integration/**/*.{test,spec}.ts',
    ],
    setupFiles: ['tests/unit/setup-dom.ts'],
    pool: 'forks',
  },
});
