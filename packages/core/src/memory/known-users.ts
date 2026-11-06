import { getConfig } from '../config.js';
import { getDocumentsByFilter, getStore, listCollections, type VectorStore } from '../store/index.js';

/** The users a set of documents shows: their authors. */
export function usersIn(docs: Array<{ metadata: Record<string, any> }>): string[] {
  const out: string[] = [];
  for (const { metadata: m } of docs) {
    if (m.username) out.push(String(m.username));
    if (m.origin_user) out.push(String(m.origin_user));
  }
  return out;
}

const CACHE_MS = 60_000;
let cache: { at: number; store: VectorStore; user: string; users: Set<string> } | undefined;

/** Every YAPA user this machine knows of: you, plus the authors of tasks and typed memories in any collection. */
export async function knownUsers(): Promise<Set<string>> {
  const store = getStore();
  const me = getConfig().USERNAME;
  if (cache && cache.store === store && cache.user === me && Date.now() - cache.at < CACHE_MS) return cache.users;
  const users = new Set<string>([me].filter(Boolean));
  const names = (await listCollections().catch(() => [])).map(c => c.name);
  await Promise.all(names.map(async c => {
    const docs = (await Promise.all([
      getDocumentsByFilter(c, { type: 'task' }, 5000).catch(() => []),
      getDocumentsByFilter(c, { type: 'memory', kind: 'decision' }, 2000).catch(() => []),
      getDocumentsByFilter(c, { type: 'memory', kind: 'question' }, 2000).catch(() => []),
    ])).flat();
    for (const u of usersIn(docs)) users.add(u);
  }));
  cache = { at: Date.now(), store, user: me, users };
  return users;
}

export function resetKnownUsers(): void {
  cache = undefined;
}
