/**
 * The system-prompt bucket as a live prompt section.
 *
 * In the MCP world, `bucket_route_now` writes a companion .md file that the
 * user must wire into their workflow and then "activate". In DSH the section
 * IS the wiring: memories promoted to the system-prompt bucket render here,
 * every assembly, with no files involved.
 *
 * `PromptSection.text` is synchronous while the store is async, so the
 * section renders from a cache refreshed on activation, on a 5-minute timer,
 * and after any bucket-routing tool call (via `tools/post-execute`).
 *
 * @module yapa/promoted-section
 */
import type { Context } from '@deepseek-ai/cordis';
import { listMemories } from '@yapa/core';
import type { ResolvedConfig } from './config.js';

export const PROMOTED_SECTION_NAME = 'yapa:promoted';
/** Between the deployment persona (0) and tool guidance (100–199). */
export const PROMOTED_SECTION_ORDER = 50;

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

async function renderPromoted(): Promise<string> {
  // include_promoted: memories promoted to a bucket are excluded from default
  // RAG; here we WANT exactly those tagged for the system-prompt bucket.
  const all = await listMemories({ include_promoted: true, limit: 500 });
  const promoted = all.filter(m =>
    typeof m.metadata.promoted_to === 'string' && m.metadata.promoted_to.startsWith('system-prompt'),
  );
  if (promoted.length === 0) return '';

  const byCollection = new Map<string, typeof promoted>();
  for (const m of promoted) {
    const arr = byCollection.get(m.collection) ?? [];
    arr.push(m);
    byCollection.set(m.collection, arr);
  }

  const lines = [
    '## Durable knowledge (promoted from YAPA memory)',
    '',
    '_These memories graduated from recall: they are always in context and no longer need retrieval._',
    '',
  ];
  for (const [collection, mems] of byCollection) {
    lines.push(`### ${collection}`);
    for (const m of mems) lines.push(`- ${m.content}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Register the cached dynamic section. No-ops when `promotedSection` is off. */
export function registerPromotedSection(ctx: Context, getResolved: () => ResolvedConfig): void {
  let cached = '';
  const refresh = async () => {
    try {
      cached = await renderPromoted();
    } catch {
      // Keep the previous cache on failure (Chroma down → section unchanged).
    }
  };

  ctx.systemPrompt.section({
    name: PROMOTED_SECTION_NAME,
    order: PROMOTED_SECTION_ORDER,
    // Empty text sections are dropped from the rendered prompt.
    text: () => (getResolved().promotedSection ? cached : ''),
  });

  void refresh();
  ctx.interval(() => void refresh(), REFRESH_INTERVAL_MS);

  // Refresh right after bucket operations change promotion state.
  ctx.on('tools/result', (exec, _result) => {
    if (
      exec.name === 'yapa_bucket_route_now'
      || exec.name === 'yapa_system_prompt_activate'
      || exec.name === 'yapa_system_prompt_deactivate'
    ) {
      void refresh();
    }
  });
}
