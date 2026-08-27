import { writeArtifact } from './artifacts.js';

export interface TrainingManifestMemory {
  id: string;
  collection: string;
  content: string;
  metadata: Record<string, any>;
}

export interface TrainingManifestResult {
  version: number;
  manifestPath: string;
  sidecarPath: string;
  memoryIds: string[];
}

/**
 * Write the training-manifest source set for a given version. This is NOT
 * the final Fireworks training JSONL — that's produced by Phase 3's synthesis
 * step, which reads this manifest and generates chat-format training examples.
 *
 * Format: JSONL, one line per memory with id, collection, content, and the
 * classifier scores for auditing.
 */
export function writeTrainingManifest(
  version: number,
  memories: TrainingManifestMemory[],
  thresholds: Record<string, number>,
): TrainingManifestResult {
  const lines = memories.map(m => JSON.stringify({
    id: m.id,
    collection: m.collection,
    content: m.content,
    trainable: m.metadata.trainable,
    durability: m.metadata.durability,
    generalizability: m.metadata.generalizability,
    rationale: m.metadata.classification_rationale,
  }));

  const manifestName = `v${version}.jsonl`;
  const sidecarName = `v${version}.manifest.json`;

  const manifestPath = writeArtifact(
    'training-manifests',
    manifestName,
    lines.join('\n') + (lines.length ? '\n' : ''),
  );

  const sidecar = JSON.stringify({
    version,
    kind: 'training-manifest',
    created_at: Math.floor(Date.now() / 1000),
    thresholds,
    memory_count: memories.length,
    memory_ids: memories.map(m => m.id),
  }, null, 2) + '\n';
  const sidecarPath = writeArtifact('training-manifests', sidecarName, sidecar);

  return {
    version,
    manifestPath,
    sidecarPath,
    memoryIds: memories.map(m => m.id),
  };
}
