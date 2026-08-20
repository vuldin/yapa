import { getConfig } from '../config.js';
import { getDocumentsByFilter, listCollections, updateDocument } from '../store/index.js';

import { CLASSIFIER_PROMPT_VERSION, classifyMemories } from './classifier.js';

export interface CurationStats {
  scored: number;
  pending: number;
  batches: number;
  errors: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

// In-memory curation state for observability (mirrors sync state)
let lastRunAt: number | null = null;
let lastError: string | null = null;
let cycleCount = 0;
let timerActive = false;
let totalScored = 0;

export function getCurationState() {
  return { lastRunAt, lastError, cycleCount, timerActive, totalScored };
}

const MAX_PER_COLLECTION = 500;

async function collectUnclassified(collection: string): Promise<
  Array<{ id: string; content: string; metadata: Record<string, any> }>
> {
  const docs = await getDocumentsByFilter(collection, { type: 'memory' }, MAX_PER_COLLECTION);
  return docs.filter(d => d.metadata.classified_at == null);
}

/**
 * Run a single curation cycle: scan every collection for unclassified memories,
 * batch them to the configured size, classify each batch via the LLM, and
 * persist scores. Returns stats, or null if skipped (previous cycle still running).
 */
export async function curationCycle(): Promise<CurationStats | null> {
  if (running) {
    process.stderr.write('[yapa-curation] Skipping cycle — previous still running\n');
    return null;
  }

  running = true;
  try {
    const stats: CurationStats = { scored: 0, pending: 0, batches: 0, errors: 0 };
    const collections = await listCollections();

    for (const c of collections) {
      let unclassified: Awaited<ReturnType<typeof collectUnclassified>>;
      try {
        unclassified = await collectUnclassified(c.name);
      } catch (e) {
        process.stderr.write(`[yapa-curation] Collection error ${c.name}: ${e}\n`);
        stats.errors++;
        continue;
      }

      stats.pending += unclassified.length;

      for (let i = 0; i < unclassified.length; i += getConfig().CURATION_BATCH_SIZE) {
        const batch = unclassified.slice(i, i + getConfig().CURATION_BATCH_SIZE);
        try {
          const scored = await classifyMemories(
            batch.map(b => ({ id: b.id, content: b.content })),
          );
          const now = Math.floor(Date.now() / 1000);

          for (const result of scored) {
            const doc = batch.find(b => b.id === result.id);
            if (!doc) continue;

            const updated: Record<string, any> = {
              ...doc.metadata,
              trainable: result.trainable,
              durability: result.durability,
              generalizability: result.generalizability,
              classified_at: now,
              classifier_prompt_version: CLASSIFIER_PROMPT_VERSION,
            };
            if (result.rationale) updated.classification_rationale = result.rationale;

            try {
              await updateDocument(c.name, doc.id, updated);
              stats.scored++;
            } catch (e) {
              process.stderr.write(`[yapa-curation] Update error for ${doc.id}: ${e}\n`);
              stats.errors++;
            }
          }
          stats.batches++;
        } catch (e) {
          process.stderr.write(`[yapa-curation] Batch error in ${c.name}: ${e}\n`);
          stats.errors++;
        }
      }
    }

    lastRunAt = Date.now();
    lastError = null;
    cycleCount++;
    totalScored += stats.scored;

    if (stats.scored > 0 || stats.errors > 0) {
      process.stderr.write(
        `[yapa-curation] Classified ${stats.scored}/${stats.pending} memories in ${stats.batches} batch(es), ${stats.errors} error(s)\n`,
      );
    }

    return stats;
  } catch (e) {
    const msg = `${e}`;
    process.stderr.write(`[yapa-curation] Cycle error: ${msg}\n`);
    lastRunAt = Date.now();
    lastError = msg;
    cycleCount++;
    return null;
  } finally {
    running = false;
  }
}

/**
 * Start the background curation process. Fires an immediate cycle (non-blocking),
 * then schedules recurring cycles every getConfig().CURATION_INTERVAL_MS.
 */
export async function startCuration(): Promise<void> {
  if (!getConfig().CURATION_ENABLED) return;

  curationCycle().catch(e =>
    process.stderr.write(`[yapa-curation] Initial cycle error: ${e}\n`),
  );

  timer = setInterval(() => {
    curationCycle().catch(e => process.stderr.write(`[yapa-curation] Cycle error: ${e}\n`));
  }, getConfig().CURATION_INTERVAL_MS);
  timerActive = true;

  process.stderr.write(
    `[yapa-curation] Background curation started (interval: ${getConfig().CURATION_INTERVAL_MS / 1000}s)\n`,
  );
}

export function stopCuration(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    timerActive = false;
  }
}
