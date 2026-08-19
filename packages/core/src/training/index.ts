import { getConfig } from '../config.js';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { getDocumentsByFilter, listCollections, updateDocument } from '../chroma.js';
import { artifactPath } from '../buckets/artifacts.js';
import { FireworksBackend } from './fireworks.js';
import {
  addAdapter,
  getAdapter,
  listAdapters,
  updateAdapter,
  type AdapterRegistryEntry,
  type AdapterStatus,
} from './registry.js';
import {
  formatTrainingJsonl,
  readManifestSource,
  synthesizeMemory,
  type SynthesisResult,
} from './synthesis.js';
import type { TrainingBackend } from './backend.js';

const MAX_PER_COLLECTION = 2000;

function getBackend(): TrainingBackend {
  switch (getConfig().TRAINING_BACKEND) {
    case 'fireworks':
      return new FireworksBackend();
    default:
      throw new Error(`Unknown training backend: ${getConfig().TRAINING_BACKEND}`);
  }
}

function previewDir(): string {
  const dir = join(getConfig().ARTIFACTS_DIR, 'training-runs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export interface DatasetPreviewResult {
  manifestVersion: number;
  previewPath: string;
  previewRef: string;
  exampleCount: number;
  skippedMemories: number;
}

/**
 * Read a manifest version, synthesize training examples, and write a preview
 * JSONL to artifacts/training-runs/. The preview's SHA-256 is returned — the
 * user must pass this back as `preview_ref` when calling training_trigger to
 * prove they've seen what they're about to train on.
 */
export async function trainingDatasetPreview(manifestVersion: number): Promise<DatasetPreviewResult> {
  const manifestName = `v${manifestVersion}.jsonl`;
  const manifestPath = artifactPath('training-manifests', manifestName);
  if (!existsSync(manifestPath)) {
    throw new Error(`Training manifest not found: ${manifestPath}. Run bucket_route_now first.`);
  }

  const sourceMemories = readManifestSource(manifestPath);
  const results: SynthesisResult[] = [];
  let skipped = 0;

  for (const mem of sourceMemories) {
    try {
      const result = await synthesizeMemory(mem);
      if (result.examples.length === 0) {
        skipped++;
      } else {
        results.push(result);
      }
    } catch (e) {
      process.stderr.write(`[yapa-training] Synthesis error for ${mem.id}: ${e}\n`);
      skipped++;
    }
  }

  const jsonl = formatTrainingJsonl(results);
  const exampleCount = results.reduce((n, r) => n + r.examples.length, 0);

  const dir = previewDir();
  const filename = `preview-v${manifestVersion}-${Date.now()}.jsonl`;
  const previewPath = join(dir, filename);
  writeFileSync(previewPath, jsonl);

  return {
    manifestVersion,
    previewPath,
    previewRef: sha256(jsonl),
    exampleCount,
    skippedMemories: skipped,
  };
}

export interface TriggerArgs {
  manifestVersion: number;
  previewPath: string;
  previewRef: string;
  confirm: true;
  adapterId?: string;
  hyperparameters?: Record<string, any>;
}

export interface TriggerResult {
  adapterId: string;
  handle: { backend: string; jobId: string };
}

/**
 * Submit a training run. Enforces the sign-off gate: the caller must pass a
 * previously-generated preview's path AND its SHA-256 hash. Both must match.
 */
export async function trainingTrigger(args: TriggerArgs): Promise<TriggerResult> {
  if (args.confirm !== true) {
    throw new Error('Refusing to submit — confirm must be true.');
  }
  if (!existsSync(args.previewPath)) {
    throw new Error(`Preview file not found: ${args.previewPath}. Run training_dataset_preview first.`);
  }
  const contentOnDisk = readFileSync(args.previewPath, 'utf-8');
  const diskHash = sha256(contentOnDisk);
  if (diskHash !== args.previewRef) {
    throw new Error(
      `Preview hash mismatch. The preview file has been modified since it was generated, or preview_ref does not match. ` +
      `Run training_dataset_preview again and pass the returned preview_ref.`,
    );
  }

  const adapterId = args.adapterId ?? `yapa-adapter-v${args.manifestVersion}-${Date.now()}`;
  const backend = getBackend();
  const now = Math.floor(Date.now() / 1000);

  const entry: AdapterRegistryEntry = {
    id: adapterId,
    manifestVersion: args.manifestVersion,
    datasetPath: args.previewPath,
    previewRef: args.previewRef,
    baseModel: getConfig().TRAINING_BASE_MODEL,
    backend: backend.name,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  addAdapter(entry);

  try {
    const handle = await backend.submit({
      datasetPath: args.previewPath,
      baseModel: getConfig().TRAINING_BASE_MODEL,
      outputModelId: adapterId,
      hyperparameters: args.hyperparameters,
    });
    updateAdapter(adapterId, {
      backendJobId: handle.jobId,
      status: 'running',
    });
    return { adapterId, handle };
  } catch (e) {
    updateAdapter(adapterId, {
      status: 'failed',
      error: String(e),
    });
    // Clear selected_for on affected memories per the plan's failure path
    await clearSelectedForManifest(args.manifestVersion);
    throw e;
  }
}

export interface TrainingStatusResult {
  adapters: AdapterRegistryEntry[];
}

export async function trainingStatus(): Promise<TrainingStatusResult> {
  return { adapters: listAdapters() };
}

export async function trainingGet(adapterId: string): Promise<{
  entry: AdapterRegistryEntry;
  remoteStatus?: { state: string; error?: string; outputModelRef?: string };
} | null> {
  const entry = getAdapter(adapterId);
  if (!entry) return null;

  if (entry.backendJobId && (entry.status === 'running' || entry.status === 'pending')) {
    try {
      const backend = getBackend();
      const status = await backend.poll({ backend: entry.backend, jobId: entry.backendJobId });
      let mappedStatus: AdapterStatus = entry.status;
      if (status.state === 'completed') mappedStatus = 'completed';
      else if (status.state === 'failed') mappedStatus = 'failed';
      else if (status.state === 'cancelled') mappedStatus = 'cancelled';
      else if (status.state === 'running') mappedStatus = 'running';
      else if (status.state === 'pending') mappedStatus = 'pending';

      const updated = updateAdapter(adapterId, {
        status: mappedStatus,
        outputModelRef: status.outputModelRef ?? entry.outputModelRef,
        error: status.error,
      });
      return {
        entry: updated ?? entry,
        remoteStatus: {
          state: status.state,
          error: status.error,
          outputModelRef: status.outputModelRef,
        },
      };
    } catch (e) {
      return {
        entry,
        remoteStatus: { state: 'unknown', error: String(e) },
      };
    }
  }

  return { entry };
}

export async function trainingCancel(adapterId: string): Promise<AdapterRegistryEntry | null> {
  const entry = getAdapter(adapterId);
  if (!entry) return null;
  if (!entry.backendJobId) {
    return updateAdapter(adapterId, { status: 'cancelled' });
  }
  const backend = getBackend();
  try {
    await backend.cancel({ backend: entry.backend, jobId: entry.backendJobId });
  } catch (e) {
    process.stderr.write(`[yapa-training] Cancel error for ${adapterId}: ${e}\n`);
  }
  const result = updateAdapter(adapterId, { status: 'cancelled' });
  await clearSelectedForManifest(entry.manifestVersion);
  return result;
}

/**
 * Clear `selected_for` on every memory routed into a training manifest version.
 * Called on training failure/cancel per the Phase 3 failure path in the plan —
 * memories return to full RAG visibility and are re-eligible next cycle.
 */
export async function clearSelectedForManifest(manifestVersion: number): Promise<{ cleared: number }> {
  const target = `training-v${manifestVersion}`;
  const collections = await listCollections();
  let cleared = 0;
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter(c.name, { type: 'memory' }, MAX_PER_COLLECTION);
      for (const d of docs) {
        if (d.metadata.selected_for === target) {
          const updated = { ...d.metadata };
          delete updated.selected_for;
          delete updated.selected_at;
          await updateDocument(c.name, d.id, updated);
          cleared++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-training] Clear selected_for error in ${c.name}: ${e}\n`);
    }
  }
  return { cleared };
}

export { sha256 };
