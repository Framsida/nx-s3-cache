import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __RELEASE_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
