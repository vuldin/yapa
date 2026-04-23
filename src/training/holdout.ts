import { readFileSync } from 'fs';
import { EVAL_HOLDOUT_FRACTION, EVAL_HOLDOUT_MIN } from '../config.js';
import { readManifestSource, type SynthesisInput } from './synthesis.js';

/**
 * Deterministic Fisher-Yates shuffle seeded from a string. Same seed →
 * same permutation across runs, which makes the holdout split reproducible
 * for a given manifest version.
 */
function seededShuffle<T>(items: T[], seed: string): T[] {
  const arr = items.slice();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // xorshift32 from the hashed seed
  let s = h || 0x9e3779b9;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff);
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export interface HoldoutSplit {
  train: SynthesisInput[];
  holdout: SynthesisInput[];
}

/**
 * Deterministically split a training manifest into train/holdout sets.
 * The split is stable per manifestVersion.
 */
export function splitManifest(
  memories: SynthesisInput[],
  manifestVersion: number,
  fraction: number = EVAL_HOLDOUT_FRACTION,
  minHoldout: number = EVAL_HOLDOUT_MIN,
): HoldoutSplit {
  if (memories.length === 0) return { train: [], holdout: [] };

  const shuffled = seededShuffle(memories, `manifest-v${manifestVersion}`);
  const raw = Math.round(memories.length * fraction);
  const holdoutSize = Math.min(
    memories.length - 1, // always keep at least 1 in train
    Math.max(Math.min(minHoldout, memories.length), raw),
  );

  return {
    train: shuffled.slice(holdoutSize),
    holdout: shuffled.slice(0, holdoutSize),
  };
}

export function loadManifestSplit(manifestPath: string, manifestVersion: number): HoldoutSplit {
  const memories = readManifestSource(manifestPath);
  return splitManifest(memories, manifestVersion);
}

/** Read a JSONL holdout file written by writeHoldout. */
export function readHoldoutFile(path: string): SynthesisInput[] {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  return lines.map(l => {
    const entry = JSON.parse(l);
    return { id: entry.id, collection: entry.collection, content: entry.content };
  });
}
