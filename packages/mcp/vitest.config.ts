import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Hook tests over the local store load the MiniLM embedder on first use.
    testTimeout: 30_000,
  },
});
