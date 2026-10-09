import { getConfig, SALIENCE_BOOST_ON_ACCESS, SALIENCE_MAX, SALIENCE_FLOOR } from './config.js';

export interface LifecycleMetadata {
  salience: number;
  accessed_at: number;
  created_at: number;
  sector: 'semantic' | 'episodic';

  /** Unix seconds this memory's salience was last decayed (wall-clock decay anchor). */
  decayed_at?: number;
  /** UTC day number (unix seconds / 86400) of the last boost, and boosts that day. */
  boost_day?: number;
  boosts_today?: number;

  // Populated by the Phase 1 classifier; scalar 0.0-1.0.
  trainable?: number;
  durability?: number;
  generalizability?: number;
  classified_at?: number;
  classification_rationale?: string;
  classifier_prompt_version?: string;

  // Promotion state machine (Phase 2+). A memory in the `selected_for`
  // intermediate state remains fully visible in recall; only `promoted_to`
  // hides it from default queries.
  selected_for?: string;
  selected_at?: number;
  promoted_to?: string;
  promoted_at?: number;

  // Per-memory training verification bookkeeping (Phase 4).
  verification_attempts?: number;
  verification_last_result?: 'passed' | 'failed';
}

/**
 * Record a use of the document: refresh `accessed_at` and boost salience by
 * SALIENCE_BOOST_ON_ACCESS — at most SALIENCE_MAX_BOOSTS_PER_DAY times per UTC
 * day, so a burst of prompts in one session can't pin a memory at the max.
 */
export function touchDocument(metadata: LifecycleMetadata, now: number = Math.floor(Date.now() / 1000)): LifecycleMetadata {
  const day = Math.floor(now / 86400);
  const boostsToday = metadata.boost_day === day ? (metadata.boosts_today ?? 0) : 0;
  if (boostsToday >= getConfig().SALIENCE_MAX_BOOSTS_PER_DAY) {
    return { ...metadata, accessed_at: now };
  }
  return {
    ...metadata,
    accessed_at: now,
    salience: Math.min(metadata.salience + SALIENCE_BOOST_ON_ACCESS, SALIENCE_MAX),
    boost_day: day,
    boosts_today: boostsToday + 1,
  };
}

/** Salience multiplier for `days` of elapsed time. Semantic memories decay at half the rate. */
export function decayFactor(sector: 'semantic' | 'episodic', days: number): number {
  const perDay = sector === 'semantic'
    ? Math.pow(getConfig().SALIENCE_DECAY_RATE, 0.5) // Slower decay for facts
    : getConfig().SALIENCE_DECAY_RATE;
  return Math.pow(perDay, Math.max(0, days));
}

/**
 * Decay salience for `days` of elapsed wall-clock time (fractional days are
 * fine). Time-based rather than per-sweep, so the curve doesn't depend on how
 * often a server happens to start.
 */
export function applyDecay(metadata: LifecycleMetadata, days: number = 1): LifecycleMetadata {
  return {
    ...metadata,
    salience: Math.max(metadata.salience * decayFactor(metadata.sector, days), SALIENCE_FLOOR),
  };
}

/** Detect semantic signals in content. */
export function detectSector(content: string): 'semantic' | 'episodic' {
  const semanticSignals = /\b(my|i am|i'm|i prefer|remember|always|never|they use|they have|their|runs on|version)\b/i;
  return semanticSignals.test(content) ? 'semantic' : 'episodic';
}
