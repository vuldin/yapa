import { getConfig } from '../config.js';
import { randomBytes } from 'crypto';
import {
  addDocument,
  deleteDocument,
  getDocumentsByFilter,
  getOrCreateCollection,
} from '../chroma.js';

import { storeMemory } from './store.js';

/**
 * Per-process session ID. One MCP server start = one "session" for journal
 * correlation. Drafts written by `journal_append` are scoped to this ID so
 * `journal_consolidate` only rolls up the current session's entries.
 *
 * Override with the YAPA_SESSION_ID env var if you need to share a session
 * across multiple processes (e.g. hooks scripting).
 */
export const SESSION_ID =
  process.env.YAPA_SESSION_ID ?? `${Date.now()}-${randomBytes(4).toString('hex')}`;

export interface JournalDraft {
  id: string;
  entry: string;
  created_at: number;
  session_id: string;
}

const DRAFT_TYPE = 'journal_draft';

/**
 * Append a one-line journal entry as a draft, scoped to the given session
 * (defaults to this process's SESSION_ID; hosts with multiple live sessions,
 * e.g. the DSH plugin, pass their own per-session key).
 */
export async function journalAppend(entry: string, collection?: string, sessionId?: string): Promise<string> {
  const col = collection ?? 'global';
  const sid = sessionId ?? SESSION_ID;
  await getOrCreateCollection(col);

  const now = Math.floor(Date.now() / 1000);
  const id = `journal-${getConfig().USERNAME}-${sid}-${now}-${Math.random().toString(36).slice(2, 6)}`;

  await addDocument(col, id, entry, {
    type: DRAFT_TYPE,
    username: getConfig().USERNAME,
    session_id: sid,
    created_at: now,
    is_synced: false,
  });

  return id;
}

/**
 * Fetch all draft entries for the current session, in chronological order.
 */
export async function listSessionDrafts(collection?: string, sessionId?: string): Promise<JournalDraft[]> {
  const col = collection ?? 'global';
  const sid = sessionId ?? SESSION_ID;
  try {
    const docs = await getDocumentsByFilter(col, {
      type: DRAFT_TYPE,
      session_id: sid,
    }, 1000);
    return docs
      .map(d => ({
        id: d.id,
        entry: d.content,
        created_at: d.metadata.created_at ?? 0,
        session_id: d.metadata.session_id ?? sid,
      }))
      .sort((a, b) => a.created_at - b.created_at);
  } catch {
    return [];
  }
}

export interface ConsolidateInput {
  collection?: string;
  summary?: string;
  /** Session whose drafts to roll up (defaults to this process's SESSION_ID). */
  sessionId?: string;
}

export interface ConsolidateResult {
  memory_id: string;
  draft_count: number;
}

/**
 * Roll the current session's drafts into a single memory tagged `journal` at
 * salience 1.5, then delete the drafts. Returns null if there are no drafts.
 */
export async function journalConsolidate(
  input: ConsolidateInput = {},
): Promise<ConsolidateResult | null> {
  const col = input.collection ?? 'global';
  const sid = input.sessionId ?? SESSION_ID;
  const drafts = await listSessionDrafts(col, sid);
  if (drafts.length === 0) return null;

  const body = input.summary
    ? input.summary
    : drafts.map(d => `- ${d.entry}`).join('\n');

  const stored = await storeMemory(`# Session journal (${sid})\n\n${body}`, {
    collection: col,
    salience: 1.5,
    sector: 'episodic',
    tags: ['journal'],
  });

  for (const d of drafts) {
    try {
      await deleteDocument(col, d.id);
    } catch (e) {
      process.stderr.write(`[yapa] journal: failed to delete draft ${d.id}: ${e}\n`);
    }
  }

  return { memory_id: stored.ids[0], draft_count: drafts.length };
}
