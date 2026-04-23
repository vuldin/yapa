import { getDocumentsByFilter, listCollections, updateDocument } from '../chroma.js';
import { getAdapter, updateAdapter } from './registry.js';

const MAX_PER_COLLECTION = 2000;

export interface PromoteArgs {
  adapterId: string;
  confirm: true;
}

export interface PromoteResult {
  adapterId: string;
  manifestVersion: number;
  promoted: number;
  rolledBackSelections: number;
  outputModelRef?: string;
}

export interface DemoteResult {
  adapterId: string;
  rolledBack: number;
}

/**
 * Promote: transition memories whose verification_last_result is 'passed' from
 * `selected_for: "training-vN"` → `promoted_to: "training-vN"`. Memories that
 * failed verification have their `selected_for` cleared (re-eligible next cycle).
 *
 * Gates:
 * - Adapter must exist in registry
 * - Adapter must be in 'completed' status (training finished)
 * - confirm must be true
 *
 * Does NOT require a specific eval score — that gate is enforced by the caller
 * (typically the MCP tool) because it depends on external eval runs the
 * registry doesn't automatically track.
 */
export async function adapterPromote(args: PromoteArgs): Promise<PromoteResult> {
  if (args.confirm !== true) {
    throw new Error('Refusing to promote — confirm must be true.');
  }
  const entry = getAdapter(args.adapterId);
  if (!entry) throw new Error(`Adapter ${args.adapterId} not found in registry.`);
  if (entry.status !== 'completed') {
    throw new Error(`Adapter ${args.adapterId} is in status ${entry.status}, not 'completed'. Cannot promote.`);
  }

  const target = `training-v${entry.manifestVersion}`;
  const collections = await listCollections();
  const now = Math.floor(Date.now() / 1000);
  let promoted = 0;
  let rolledBackSelections = 0;

  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter(c.name, { type: 'memory' }, MAX_PER_COLLECTION);
      for (const d of docs) {
        if (d.metadata.selected_for !== target) continue;

        if (d.metadata.verification_last_result === 'passed') {
          await updateDocument(c.name, d.id, {
            ...d.metadata,
            promoted_to: target,
            promoted_at: now,
          });
          promoted++;
        } else {
          const updated = { ...d.metadata };
          delete updated.selected_for;
          delete updated.selected_at;
          await updateDocument(c.name, d.id, updated);
          rolledBackSelections++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-promote] Error in ${c.name}: ${e}\n`);
    }
  }

  updateAdapter(args.adapterId, { status: 'promoted', promoted: true });

  return {
    adapterId: args.adapterId,
    manifestVersion: entry.manifestVersion,
    promoted,
    rolledBackSelections,
    outputModelRef: entry.outputModelRef,
  };
}

/**
 * Demote: reverse a promotion. Clears `promoted_to` on every memory associated
 * with the given adapter's manifest version. Memories become visible in
 * default RAG again.
 */
export async function adapterDemote(adapterId: string): Promise<DemoteResult> {
  const entry = getAdapter(adapterId);
  if (!entry) throw new Error(`Adapter ${adapterId} not found in registry.`);

  const target = `training-v${entry.manifestVersion}`;
  const collections = await listCollections();
  let rolledBack = 0;

  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter(c.name, { type: 'memory' }, MAX_PER_COLLECTION);
      for (const d of docs) {
        if (d.metadata.promoted_to === target) {
          const updated = { ...d.metadata };
          delete updated.promoted_to;
          delete updated.promoted_at;
          await updateDocument(c.name, d.id, updated);
          rolledBack++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-demote] Error in ${c.name}: ${e}\n`);
    }
  }

  updateAdapter(adapterId, { status: 'demoted', promoted: false });

  return { adapterId, rolledBack };
}
