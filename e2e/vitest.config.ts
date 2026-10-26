import { defineConfig } from 'vitest/config';

// Installs Nx versions and talks to a real deployment: slow, and serial so
// the steps of each scenario stay in order.
export default defineConfig({
  test: {
    include: ['suites/**/*.e2e.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
