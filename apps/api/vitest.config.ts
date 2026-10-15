import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one test database: run files one after another
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: './test/global-setup.ts',
  },
});
