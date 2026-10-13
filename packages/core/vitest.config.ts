import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Suites over the local store load the MiniLM embedder; the first load
    // (model download/ONNX init) can exceed vitest's defaults on a cold cache,
    // and suites that seed the store in beforeAll pay it in the hook.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
