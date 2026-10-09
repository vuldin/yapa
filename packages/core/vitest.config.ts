import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Suites over the local store load the MiniLM embedder; the first load
    // (model download/ONNX init) can exceed vitest's 5s default on a cold cache.
    testTimeout: 30_000,
  },
});
