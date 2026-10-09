import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The integration suite creates a database and applies the schema once.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
