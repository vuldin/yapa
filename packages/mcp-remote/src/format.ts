/**
 * Text output for the MCP tools, close to the local plugin's format
 * (packages/mcp/src/tools.ts) plus attribution, since remote readers see the
 * whole team's rows. Sizes are bounded: 4 KiB of content per item and 64 KiB
 * per tool result.
 */
import type { DocRow } from './queries.js';

export const MAX_ITEM_CONTENT_BYTES = 4 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;

const TRUNCATED = ' …[truncated]';

/** Cut `s` to at most `max` UTF-8 bytes (never splitting a character) and mark it. */
export function truncateBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const budget = Math.max(0, max - Buffer.byteLength(TRUNCATED, 'utf8'));
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + TRUNCATED;
}

export function itemContent(s: string): string {
  return truncateBytes(s, MAX_ITEM_CONTENT_BYTES);
}

/**
 * Joins blocks until the result budget is reached, then notes how many were
 * left out. `footer` lines (cursors, hints) are always kept.
 */
export function joinBounded(blocks: string[], sep: string, footer: string[] = [], max = MAX_RESULT_BYTES): string {
  const tail = footer.length ? `\n\n${footer.join('\n')}` : '';
  const reserve = Buffer.byteLength(tail, 'utf8') + 120; // room for the omission note
  const out: string[] = [];
  let used = 0;
  for (const b of blocks) {
    const n = Buffer.byteLength(b, 'utf8') + (out.length ? Buffer.byteLength(sep, 'utf8') : 0);
    if (used + n > max - reserve) break;
    out.push(b);
    used += n;
  }
  let text = out.join(sep);
  const omitted = blocks.length - out.length;
  if (omitted > 0) text += `${out.length ? sep : ''}…[${omitted} more item(s) omitted: result size limit]`;
  return text + tail;
}

export function isoDate(secs: number): string {
  return new Date(secs * 1000).toISOString().slice(0, 10);
}

export function isoMinute(secs: number): string {
  return `${new Date(secs * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/** "by alice" or "by alice, edited by bob". */
export function author(r: Pick<DocRow, 'origin_user' | 'last_editor'>): string {
  const by = `by ${r.origin_user}`;
  return r.last_editor && r.last_editor !== r.origin_user ? `${by}, edited by ${r.last_editor}` : by;
}

export function list(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(String).filter(Boolean);
  return (x ?? '').toString().split(',').map((s: string) => s.trim()).filter(Boolean);
}

export function salience(m: Record<string, any>): string {
  return typeof m.salience === 'number' ? m.salience.toFixed(2) : '?';
}

/** due_date 0 is core's "no due date" sentinel. */
export function dueDate(m: Record<string, any>): string | undefined {
  const d = Number(m.due_date);
  return Number.isFinite(d) && d > 0 ? isoDate(d) : undefined;
}
