#!/usr/bin/env node
// Image build step: download the embedding model into <dir> (default
// /app/models) and check it produces a 384-d vector, so the runtime image can
// run with YAPA_MCP_ALLOW_REMOTE_MODELS=false. Run after `npm run build`
// (it imports the built @yapa/core).
import { createLocalEmbedder, LOCAL_EMBEDDING_DIMS, LOCAL_EMBEDDING_MODEL } from '@yapa/core/local-embedder';

const dir = process.argv[2] ?? '/app/models';
const v = await createLocalEmbedder({ cacheDir: dir, allowRemote: true }).embed('warm up');
if (v.length !== LOCAL_EMBEDDING_DIMS) {
  console.error(`expected ${LOCAL_EMBEDDING_DIMS} dimensions, got ${v.length}`);
  process.exit(1);
}
console.log(`${LOCAL_EMBEDDING_MODEL} cached in ${dir} (${v.length} dims)`);
