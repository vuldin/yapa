import {
  SALIENCE_FLOOR,
  SALIENCE_MAX,
  SALIENCE_RANKING_WEIGHT,
  SALIENCE_START,
} from '../config.js';

export interface RecallFilters {
  trainable_min?: number;
  durability_min?: number;
  generalizability_min?: number;
  classified?: boolean;
}

/** Default-exclude memories with a final `promoted_to` state (Phase 0 contract). */
export function passesPromotedFilter(
  metadata: Record<string, any>,
  includePromoted: boolean,
): boolean {
  if (includePromoted) return true;
  return metadata.promoted_to == null;
}

export function passesScoreFilters(
  metadata: Record<string, any>,
  filters: RecallFilters | undefined,
): boolean {
  if (!filters) return true;
  if (filters.trainable_min != null && (metadata.trainable ?? -Infinity) < filters.trainable_min) {
    return false;
  }
  if (filters.durability_min != null && (metadata.durability ?? -Infinity) < filters.durability_min) {
    return false;
  }
  if (
    filters.generalizability_min != null &&
    (metadata.generalizability ?? -Infinity) < filters.generalizability_min
  ) {
    return false;
  }
  if (filters.classified === true && metadata.classified_at == null) return false;
  if (filters.classified === false && metadata.classified_at != null) return false;
  return true;
}

/** Map salience onto [0, 1] across the configured floor/max range. */
export function normalizedSalience(salience: number | undefined): number {
  const s = salience ?? SALIENCE_START;
  const span = SALIENCE_MAX - SALIENCE_FLOOR;
  if (span <= 0) return 0;
  const n = (s - SALIENCE_FLOOR) / span;
  return Math.max(0, Math.min(1, n));
}

/**
 * Combined ranking score. Lower is better — mirrors the distance-ascending
 * convention already used for ChromaDB results. High salience subtracts,
 * effectively pulling high-salience documents up the ranking.
 */
export function rankScore(distance: number, salience: number | undefined): number {
  return distance - SALIENCE_RANKING_WEIGHT * normalizedSalience(salience);
}
