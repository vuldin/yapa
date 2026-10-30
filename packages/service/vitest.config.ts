import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The integration suite creates a database and applies the schema once.
    hookTimeout: 60_000,
    // The integration files share one runtime role; concurrent ALTER ROLE/GRANT
    // on it fails with "tuple concurrently updated".
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
