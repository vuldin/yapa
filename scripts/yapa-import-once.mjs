// One-shot import: ChromaDB -> local store, using rebuilt @yapa/core.
// Run from repo root: node scripts/yapa-import-once.mjs  (delete after use)
process.env.YAPA_STORAGE = 'local';
process.env.YAPA_LOCAL_STORE_PATH = '/tmp/yapa-local-test';
process.env.YAPA_CHROMA_URL = process.env.YAPA_CHROMA_URL ?? 'http://localhost:8000';

const core = await import('../packages/core/dist/index.js');

const sourceCols = (await core.chromaStore.listCollections()).map(c => c.name);
console.log(`Source collections: ${sourceCols.join(', ') || '(none)'}`);

let total = 0;
const lines = [];
for (const name of sourceCols) {
  const docs = await core.chromaStore.getDocumentsByFilter(name, {}, 100000);
  if (docs.length === 0) { lines.push(`  - ${name}: 0 documents`); continue; }
  await core.getOrCreateCollection(name);
  await core.addDocumentsBatch(name, docs.map(d => ({ id: d.id, content: d.content, metadata: d.metadata })));
  total += docs.length;
  lines.push(`  - ${name}: ${docs.length} document(s)`);
}
console.log(lines.join('\n'));
console.log(`Imported ${total} document(s) across ${sourceCols.length} collection(s).`);
