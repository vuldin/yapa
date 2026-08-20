/**
 * Pre-compaction capture: when the harness compacts conversation history,
 * the distillation work has already been done — `compaction/summary` carries
 * the summary content. Store it as a yapa memory so knowledge survives
 * context-window compaction in long-term memory too.
 *
 * Conservative by default: salience 1.5, tagged `compaction`, sector episodic,
 * in the session's detected collection. Disable with `captureCompaction: false`.
 *
 * @module yapa-dsh/compaction-capture
 */
import type { Context } from '@deepseek-ai/cordis';
// Loads the compaction event vocabulary into the session event map.
import type {} from '@deepseek-ai/dsh-compaction';
import { storeMemory } from '@yapa/core';
import { detectCollection } from './injector.js';
import type { ResolvedConfig } from './config.js';

const log = (msg: string) => process.stderr.write(`[yapa] ${msg}\n`);

export function registerCompactionCapture(ctx: Context, getResolved: () => ResolvedConfig): void {
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/summary') return;
    if (!getResolved().captureCompaction) return;

    void (async () => {
      try {
        const data = event.data as {
          summary?: Array<{ type?: string; text?: string }>;
          shadowedTokenCount?: number;
          compactionId?: string;
        };
        const summaryText = (data.summary ?? [])
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text!)
          .join('\n')
          .trim();
        if (!summaryText) return;

        const collection = await detectCollection(session.header.cwd, getResolved().projectRoots);
        await storeMemory(
          `# Conversation compaction summary\n\n${summaryText}`,
          {
            tags: ['compaction', 'journal'],
            salience: 1.5,
            sector: 'episodic',
            collection,
          },
        );
        log(`Captured compaction summary (${data.shadowedTokenCount ?? '?'} shadowed tokens) into ${collection}`);
      } catch (e) {
        log(`Compaction capture failed (non-fatal): ${e}`);
      }
    })();
  });
}
