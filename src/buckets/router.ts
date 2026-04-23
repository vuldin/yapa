import {
  SYSTEM_PROMPT_DURABILITY_MIN,
  SYSTEM_PROMPT_GENERALIZABILITY_MIN,
  SYSTEM_PROMPT_TRAINABLE_MIN,
  TRAINING_DURABILITY_MIN,
  TRAINING_GENERALIZABILITY_MIN,
  TRAINING_TRAINABLE_MIN,
} from '../config.js';

export type Bucket = 'system-prompt' | 'training';

export interface Thresholds {
  trainable: number;
  durability: number;
  generalizability: number;
}

export function systemPromptThresholds(): Thresholds {
  return {
    trainable: SYSTEM_PROMPT_TRAINABLE_MIN,
    durability: SYSTEM_PROMPT_DURABILITY_MIN,
    generalizability: SYSTEM_PROMPT_GENERALIZABILITY_MIN,
  };
}

export function trainingThresholds(): Thresholds {
  return {
    trainable: TRAINING_TRAINABLE_MIN,
    durability: TRAINING_DURABILITY_MIN,
    generalizability: TRAINING_GENERALIZABILITY_MIN,
  };
}

export interface RouterInput {
  metadata: Record<string, any>;
}

export interface RouterDecision {
  buckets: Bucket[];
  reasons: Record<Bucket, string>;
}

/**
 * Decide which bucket(s), if any, a classified memory belongs to.
 *
 * Rules:
 *  - A memory must be classified (have trainable/durability/generalizability scores).
 *  - A memory must not already be promoted to the bucket in question (dedup).
 *  - A memory's scores must meet ALL THREE minima for the target bucket.
 *
 * A memory can be eligible for BOTH buckets; router returns all matches.
 * Returning the empty array means the memory stays in live RAG only.
 */
export function routeMemory(
  input: RouterInput,
  custom?: { systemPrompt?: Thresholds; training?: Thresholds },
): RouterDecision {
  const { metadata } = input;
  const sp = custom?.systemPrompt ?? systemPromptThresholds();
  const tr = custom?.training ?? trainingThresholds();

  const buckets: Bucket[] = [];
  const reasons: Record<Bucket, string> = {
    'system-prompt': '',
    training: '',
  };

  if (metadata.classified_at == null) {
    const r = 'not classified yet';
    reasons['system-prompt'] = r;
    reasons.training = r;
    return { buckets, reasons };
  }

  const t = Number(metadata.trainable ?? 0);
  const d = Number(metadata.durability ?? 0);
  const g = Number(metadata.generalizability ?? 0);

  const spRecord = metadata.promoted_to?.toString().startsWith('system-prompt') ||
    metadata.selected_for?.toString().startsWith('system-prompt');
  const trRecord = metadata.promoted_to?.toString().startsWith('training') ||
    metadata.selected_for?.toString().startsWith('training');

  if (spRecord) {
    reasons['system-prompt'] = 'already routed to system-prompt bucket';
  } else if (t >= sp.trainable && d >= sp.durability && g >= sp.generalizability) {
    buckets.push('system-prompt');
    reasons['system-prompt'] = `scores meet system-prompt thresholds (t=${t.toFixed(2)} d=${d.toFixed(2)} g=${g.toFixed(2)})`;
  } else {
    reasons['system-prompt'] = belowReason('system-prompt', sp, t, d, g);
  }

  if (trRecord) {
    reasons.training = 'already routed to training bucket';
  } else if (t >= tr.trainable && d >= tr.durability && g >= tr.generalizability) {
    buckets.push('training');
    reasons.training = `scores meet training thresholds (t=${t.toFixed(2)} d=${d.toFixed(2)} g=${g.toFixed(2)})`;
  } else {
    reasons.training = belowReason('training', tr, t, d, g);
  }

  return { buckets, reasons };
}

function belowReason(bucket: Bucket, th: Thresholds, t: number, d: number, g: number): string {
  const miss: string[] = [];
  if (t < th.trainable) miss.push(`trainable ${t.toFixed(2)} < ${th.trainable}`);
  if (d < th.durability) miss.push(`durability ${d.toFixed(2)} < ${th.durability}`);
  if (g < th.generalizability) miss.push(`generalizability ${g.toFixed(2)} < ${th.generalizability}`);
  return `below ${bucket}: ${miss.join(', ')}`;
}
