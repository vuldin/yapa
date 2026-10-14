import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The embedding parity test loads the ONNX model; the integration suite creates a database.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
