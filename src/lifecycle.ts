import { SALIENCE_BOOST_ON_ACCESS, SALIENCE_MAX, SALIENCE_DECAY_RATE, SALIENCE_FLOOR } from './config.js';

export interface LifecycleMetadata {
  salience: number;
  accessed_at: number;
  created_at: number;
  sector: 'semantic' | 'episodic';
}

/** Boost salience when document is accessed. */
export function touchDocument(metadata: LifecycleMetadata): LifecycleMetadata {
  return {
    ...metadata,
    accessed_at: Math.floor(Date.now() / 1000),
    salience: Math.min(metadata.salience + SALIENCE_BOOST_ON_ACCESS, SALIENCE_MAX),
  };
}

/**
 * Apply daily decay to salience.
 * Semantic memories decay slower than episodic.
 */
export function applyDecay(metadata: LifecycleMetadata): LifecycleMetadata {
  const decayMultiplier = metadata.sector === 'semantic'
    ? Math.pow(SALIENCE_DECAY_RATE, 0.5) // Slower decay for facts
    : SALIENCE_DECAY_RATE;

  return {
    ...metadata,
    salience: Math.max(metadata.salience * decayMultiplier, SALIENCE_FLOOR),
  };
}

/** Detect semantic signals in content. */
export function detectSector(content: string): 'semantic' | 'episodic' {
  const semanticSignals = /\b(my|i am|i'm|i prefer|remember|always|never|they use|they have|their|runs on|version)\b/i;
  return semanticSignals.test(content) ? 'semantic' : 'episodic';
}
