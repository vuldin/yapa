import { getConfig } from '../config.js';
import { getDocumentsByFilter, listCollections, updateDocument } from '../chroma.js';

import { nextVersion, writeArtifact } from './artifacts.js';
import {
  routeMemory,
  systemPromptThresholds,
  trainingThresholds,
  type Bucket,
} from './router.js';
import { writeSystemPromptCompanion } from './system-prompt.js';
import { writeTrainingManifest } from './training-manifest.js';

const MAX_PER_COLLECTION = 2000;

interface ClassifiedMemory {
  id: string;
  collection: string;
  content: string;
  metadata: Record<string, any>;
}

interface RoutingEntry extends ClassifiedMemory {
  buckets: Bucket[];
  reasons: Record<Bucket, string>;
}

export interface BucketRoutePreview {
  systemPromptVersion: number;
  trainingVersion: number;
  systemPromptCandidates: RoutingEntry[];
  trainingCandidates: RoutingEntry[];
  thresholds: {
    systemPrompt: { trainable: number; durability: number; generalizability: number };
    training: { trainable: number; durability: number; generalizability: number };
  };
}

export interface BucketRouteResult extends BucketRoutePreview {
  systemPromptArtifact?: { companionPath: string; manifestPath: string };
  trainingArtifact?: { manifestPath: string; sidecarPath: string };
  routingDecisionsPath: string;
  tagged: number;
}

export async function collectClassifiedMemories(): Promise<ClassifiedMemory[]> {
  const collections = await listCollections();
  const out: ClassifiedMemory[] = [];
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter(c.name, { type: 'memory' }, MAX_PER_COLLECTION);
      for (const d of docs) {
        if (d.metadata.classified_at != null) {
          out.push({
            id: d.id,
            collection: c.name,
            content: d.content,
            metadata: d.metadata,
          });
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}

function computeRouting(memories: ClassifiedMemory[]): RoutingEntry[] {
  const sp = systemPromptThresholds();
  const tr = trainingThresholds();
  return memories.map(m => {
    const decision = routeMemory({ metadata: m.metadata }, { systemPrompt: sp, training: tr });
    return { ...m, buckets: decision.buckets, reasons: decision.reasons };
  });
}

function collectCurrentThresholds() {
  return {
    systemPrompt: {
      trainable: getConfig().SYSTEM_PROMPT_TRAINABLE_MIN,
      durability: getConfig().SYSTEM_PROMPT_DURABILITY_MIN,
      generalizability: getConfig().SYSTEM_PROMPT_GENERALIZABILITY_MIN,
    },
    training: {
      trainable: getConfig().TRAINING_TRAINABLE_MIN,
      durability: getConfig().TRAINING_DURABILITY_MIN,
      generalizability: getConfig().TRAINING_GENERALIZABILITY_MIN,
    },
  };
}

/** Produce a dry-run preview of how routing would assign buckets. */
export async function bucketRoutePreview(): Promise<BucketRoutePreview> {
  const memories = await collectClassifiedMemories();
  const entries = computeRouting(memories);
  return {
    systemPromptVersion: nextVersion('system-prompt-companion'),
    trainingVersion: nextVersion('training-manifests'),
    systemPromptCandidates: entries.filter(e => e.buckets.includes('system-prompt')),
    trainingCandidates: entries.filter(e => e.buckets.includes('training')),
    thresholds: collectCurrentThresholds(),
  };
}

/**
 * Execute routing: write artifacts, tag qualifying memories with `selected_for`
 * (intermediate state — memories remain visible in RAG). Does NOT set
 * `promoted_to` — that transition happens later (system-prompt via explicit
 * activation; training via Phase 4 adapter promotion after verification).
 */
export async function bucketRouteNow(): Promise<BucketRouteResult> {
  const memories = await collectClassifiedMemories();
  const entries = computeRouting(memories);
  const spVersion = nextVersion('system-prompt-companion');
  const trVersion = nextVersion('training-manifests');

  const spCandidates = entries.filter(e => e.buckets.includes('system-prompt'));
  const trCandidates = entries.filter(e => e.buckets.includes('training'));
  const thresholds = collectCurrentThresholds();

  let systemPromptArtifact: BucketRouteResult['systemPromptArtifact'];
  if (spCandidates.length > 0) {
    const result = writeSystemPromptCompanion(spVersion, spCandidates, {
      trainable: thresholds.systemPrompt.trainable,
      durability: thresholds.systemPrompt.durability,
      generalizability: thresholds.systemPrompt.generalizability,
    });
    systemPromptArtifact = { companionPath: result.companionPath, manifestPath: result.manifestPath };
  }

  let trainingArtifact: BucketRouteResult['trainingArtifact'];
  if (trCandidates.length > 0) {
    const result = writeTrainingManifest(trVersion, trCandidates, {
      trainable: thresholds.training.trainable,
      durability: thresholds.training.durability,
      generalizability: thresholds.training.generalizability,
    });
    trainingArtifact = { manifestPath: result.manifestPath, sidecarPath: result.sidecarPath };
  }

  // Tag memories with selected_for (intermediate state; still visible in RAG)
  const now = Math.floor(Date.now() / 1000);
  let tagged = 0;

  async function tag(entry: RoutingEntry, bucket: Bucket, tag: string) {
    const updated: Record<string, any> = {
      ...entry.metadata,
      selected_for: tag,
      selected_at: now,
    };
    try {
      await updateDocument(entry.collection, entry.id, updated);
      tagged++;
    } catch (e) {
      process.stderr.write(`[yapa-buckets] Tag error for ${entry.id}: ${e}\n`);
    }
  }

  if (spCandidates.length > 0) {
    for (const e of spCandidates) await tag(e, 'system-prompt', `system-prompt-v${spVersion}`);
  }
  if (trCandidates.length > 0) {
    for (const e of trCandidates) await tag(e, 'training', `training-v${trVersion}`);
  }

  // Audit log of all routing decisions, including memories that went to neither bucket
  const decisions = entries.map(e => ({
    id: e.id,
    collection: e.collection,
    buckets: e.buckets,
    reasons: e.reasons,
    scores: {
      trainable: e.metadata.trainable,
      durability: e.metadata.durability,
      generalizability: e.metadata.generalizability,
    },
  }));
  const routingDecisions = JSON.stringify({
    created_at: now,
    system_prompt_version: spCandidates.length > 0 ? spVersion : null,
    training_version: trCandidates.length > 0 ? trVersion : null,
    thresholds,
    decisions,
  }, null, 2) + '\n';

  // Use the higher of the two version numbers for the audit filename so it
  // stays chronologically aligned with the artifact that triggered it.
  const auditVersion = Math.max(spVersion, trVersion);
  const routingDecisionsPath = writeArtifact(
    'routing-decisions',
    `v${auditVersion}.json`,
    routingDecisions,
  );

  if (spCandidates.length > 0 || trCandidates.length > 0) {
    process.stderr.write(
      `[yapa-buckets] Routed ${spCandidates.length} to system-prompt-v${spVersion}, ${trCandidates.length} to training-v${trVersion}\n`,
    );
  } else {
    process.stderr.write('[yapa-buckets] No memories met routing thresholds\n');
  }

  return {
    systemPromptVersion: spVersion,
    trainingVersion: trVersion,
    systemPromptCandidates: spCandidates,
    trainingCandidates: trCandidates,
    thresholds,
    systemPromptArtifact,
    trainingArtifact,
    routingDecisionsPath,
    tagged,
  };
}

/** Transition all memories routed to a system-prompt version from
 *  `selected_for` → `promoted_to`. Called when the user confirms they have
 *  wired the companion file into their workflow. */
export async function systemPromptActivate(version: number): Promise<{ promoted: number }> {
  const target = `system-prompt-v${version}`;
  const collections = await listCollections();
  let promoted = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter(c.name, { type: 'memory' }, MAX_PER_COLLECTION);
      for (const d of docs) {
        if (d.metadata.selected_for === target && d.metadata.promoted_to == null) {
          await updateDocument(c.name, d.id, {
            ...d.metadata,
            promoted_to: target,
            promoted_at: now,
          });
          promoted++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-buckets] Activate error in ${c.name}: ${e}\n`);
    }
  }

  return { promoted };
}

/** Reverse system_prompt_activate: clear promoted_to for the given version. */
export async function systemPromptDeactivate(version: number): Promise<{ rolledBack: number }> {
  const target = `system-prompt-v${version}`;
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
      process.stderr.write(`[yapa-buckets] Deactivate error in ${c.name}: ${e}\n`);
    }
  }

  return { rolledBack };
}

export async function bucketStatus(): Promise<{
  bySelection: Record<string, number>;
  byPromotion: Record<string, number>;
  pendingClassification: number;
}> {
  const collections = await listCollections();
  const bySelection: Record<string, number> = {};
  const byPromotion: Record<string, number> = {};
  let pendingClassification = 0;

  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter(c.name, { type: 'memory' }, MAX_PER_COLLECTION);
      for (const d of docs) {
        if (d.metadata.classified_at == null) pendingClassification++;
        const sel = d.metadata.selected_for;
        const prom = d.metadata.promoted_to;
        if (sel) bySelection[sel] = (bySelection[sel] ?? 0) + 1;
        if (prom) byPromotion[prom] = (byPromotion[prom] ?? 0) + 1;
      }
    } catch {
      continue;
    }
  }

  return { bySelection, byPromotion, pendingClassification };
}
