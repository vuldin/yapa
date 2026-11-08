/**
 * Recurring tasks. A series keeps its calendar slots: occurrence k (k >= 1)
 * is due at recurrence_anchor + k * interval periods, counted in local time
 * from the anchor (month, quarter and year steps keep the anchor's day of
 * month, clamped to the target month's last day). Completing an occurrence
 * creates the next one at the first slot strictly after max(its own slot
 * (recurrence_slot; moving its due date doesn't change it), now). An
 * occurrence is upcoming, and hidden from task lists, until lead_days before
 * the day it is due (opens_at).
 */
import { formatTaskDate, formatTaskDay, parseRelativeDate } from './dates.js';

export const RECURRENCE_PATTERNS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type RecurrencePattern = (typeof RECURRENCE_PATTERNS)[number];

/** Days before the due day an occurrence opens, by pattern (the interval doesn't change it). */
export const DEFAULT_LEAD_DAYS: Record<RecurrencePattern, number> = { daily: 0, weekly: 2, monthly: 7, quarterly: 14, yearly: 30 };

export class RecurrenceError extends Error {}

export const isRecurrencePattern = (p: unknown): p is RecurrencePattern => RECURRENCE_PATTERNS.includes(p as RecurrencePattern);

const MONTHS: Partial<Record<RecurrencePattern, number>> = { monthly: 1, quarterly: 3, yearly: 12 };
const DAYS: Partial<Record<RecurrencePattern, number>> = { daily: 1, weekly: 7 };
/** Longest one period can be, in seconds (a DST hour included): k slots never lie further than k of these from the anchor. */
const MAX_PERIOD: Record<RecurrencePattern, number> = {
  daily: 25 * 3600, weekly: 7 * 86400 + 3600, monthly: 31 * 86400 + 3600, quarterly: 92 * 86400 + 3600, yearly: 366 * 86400 + 3600,
};

/** Slot k of a series (unix seconds). */
export function recurrenceSlot(anchor: number, pattern: RecurrencePattern, interval: number, k: number): number {
  const a = new Date(anchor * 1000);
  const steps = k * interval;
  let y = a.getFullYear(), m = a.getMonth(), d = a.getDate();
  if (MONTHS[pattern]) {
    m += steps * MONTHS[pattern]!;
    d = Math.min(d, new Date(y, m + 1, 0).getDate());
  } else {
    d += steps * DAYS[pattern]!;
  }
  return Math.floor(new Date(y, m, d, a.getHours(), a.getMinutes(), a.getSeconds()).getTime() / 1000);
}

/** The first slot of the series strictly after `after`. */
export function nextRecurrenceDue(anchor: number, pattern: RecurrencePattern, interval: number, after: number): number {
  let k = Math.max(1, Math.floor((after - anchor) / (MAX_PERIOD[pattern] * interval)));
  let slot = recurrenceSlot(anchor, pattern, interval, k);
  while (slot <= after) slot = recurrenceSlot(anchor, pattern, interval, ++k);
  return slot;
}

const truthy = (v: unknown) => v === true || v === 'true';
const nonNegInt = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

export function isRecurring(m: Record<string, any>): boolean {
  return truthy(m.is_recurring) && isRecurrencePattern(m.recurrence_pattern);
}

export function recurrenceInterval(m: Record<string, any>): number {
  const n = nonNegInt(m.recurrence_interval);
  return n && n >= 1 ? n : 1;
}

export function leadDays(m: Record<string, any>): number {
  return nonNegInt(m.lead_days) ?? DEFAULT_LEAD_DAYS[m.recurrence_pattern as RecurrencePattern] ?? 0;
}

/** The slot this occurrence holds in its series: recurrence_slot, else (before slots were stored) its due date. */
export function occurrenceSlot(m: Record<string, any>): number {
  const slot = Number(m.recurrence_slot);
  return slot > 0 ? slot : Number(m.due_date) > 0 ? Number(m.due_date) : 0;
}

/** When an occurrence due at `due` opens: the start of its due day, `lead` days earlier (local time). */
export function opensAt(due: number, lead: number): number {
  const d = new Date(due * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - lead).getTime() / 1000);
}

/**
 * The opening time stored when the task was written (`opens_at`, in its
 * writer's time zone), if it still fits the due date and lead time: within
 * the day before the due date, lead_days earlier. Undefined when absent or
 * stale (a due date moved by a client that doesn't store it).
 */
export function storedOpensAt(m: Record<string, any>): number | undefined {
  const stored = Number(m.opens_at), due = Number(m.due_date);
  if (!(stored > 0) || !(due > 0) || !Number.isFinite(stored) || !Number.isFinite(due)) return undefined;
  const lead = leadDays(m);
  return stored <= due - lead * 86400 + 3600 && stored > due - (lead + 1) * 86400 - 3600 ? stored : undefined;
}

/** How an opening time is worked out when none is stored: (due, lead) -> unix seconds. */
export type OpeningRule = (due: number, lead: number) => number;

/** When this occurrence opens: as stored, else by `fallback` (default: the start of the due day here, as opensAt). */
export function opensAtOf(m: Record<string, any>, fallback: OpeningRule = opensAt): number {
  return storedOpensAt(m) ?? fallback(Number(m.due_date), leadDays(m));
}

/** Upcoming: a pending occurrence of a recurring task that hasn't opened yet. */
export function isUpcoming(m: Record<string, any>, now = Math.floor(Date.now() / 1000), fallback: OpeningRule = opensAt): boolean {
  const due = Number(m.due_date);
  return isRecurring(m) && Number.isFinite(due) && due > 0 && (m.status ?? 'pending') === 'pending' && now < opensAtOf(m, fallback);
}

/** "weekly", "every 2 months". */
export function describeRecurrence(m: Record<string, any>): string {
  const n = recurrenceInterval(m);
  if (n === 1) return String(m.recurrence_pattern);
  const unit = { daily: 'days', weekly: 'weeks', monthly: 'months', quarterly: 'quarters', yearly: 'years' }[m.recurrence_pattern as RecurrencePattern];
  return `every ${n} ${unit}`;
}

/** For a listing: "upcoming: due Fri, Nov 14, opens Wed, Nov 12", or '' when the task is open. */
export function upcomingNote(m: Record<string, any>, now = Math.floor(Date.now() / 1000)): string {
  if (!isUpcoming(m, now)) return '';
  return `upcoming: due ${formatTaskDate(Number(m.due_date))}, opens ${formatTaskDay(opensAtOf(m))}`;
}

/** "repeats weekly, opens 2 day(s) before it is due", or '' when not recurring. */
export function recurrenceNote(m: Record<string, any>): string {
  if (!isRecurring(m)) return '';
  const lead = leadDays(m);
  return `repeats ${describeRecurrence(m)}, ${lead ? `opens ${lead} day(s) before it is due` : 'opens on the day it is due'}`;
}

/** What a series does now, for a reply after creating or changing it. */
export function recurrenceLine(m: Record<string, any>, now = Math.floor(Date.now() / 1000)): string {
  const repeats = recurrenceNote(m);
  if (!repeats) return 'Not recurring: completing it creates no next occurrence.';
  const head = `${repeats[0].toUpperCase()}${repeats.slice(1)}`;
  const due = Number(m.due_date);
  if (!(due > 0)) return `${head}.`;
  const when = isUpcoming(m, now) ? `opens ${formatTaskDay(opensAtOf(m))} (hidden from task lists until then)` : 'open now';
  return `${head}; this occurrence is due ${formatTaskDate(due)}, ${when}.`;
}

/** The line a task listing ends with when it left upcoming occurrences out. */
export function hiddenUpcomingLine(n: number): string {
  return n ? `_${n} upcoming recurring task(s) hidden (not open yet): pass include_upcoming: true to show them._` : '';
}

/** Today, as a `due: "today"` phrase gives it (end of day). */
export const todayDue = (): number => parseRelativeDate('today')!;

export function checkInterval(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 1) throw new RecurrenceError('recurrence_interval must be an integer of at least 1');
  return v as number;
}

export function checkLeadDays(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 0) throw new RecurrenceError('lead_days must be a non-negative integer');
  return v as number;
}

/** The task_update parameters that change a series (MCP, DSH, and updateTask's re-sync keys). */
export const SERIES_PARAMS = ['recurrence_pattern', 'recurrence_interval', 'lead_days', 'series_notes'] as const;

/** Did these update parameters change the series? */
export const seriesChanged = (params: Record<string, unknown>): boolean => SERIES_PARAMS.some(k => params[k] !== undefined);

export interface SeriesInfo {
  pattern: RecurrencePattern;
  interval: number;
  lead_days: number;
  anchor: number | null;
  slot: number | null;
  series: string;
  previous: string | null;
  next: string | null;
  series_notes: string | null;
  upcoming: boolean;
  opens_at: number | null;
}

/** A task's series, for listings and JSON; null when it isn't recurring. */
export function seriesInfo(m: Record<string, any>, id: string, now = Math.floor(Date.now() / 1000)): SeriesInfo | null {
  if (!isRecurring(m)) return null;
  const due = Number(m.due_date);
  return {
    pattern: m.recurrence_pattern,
    interval: recurrenceInterval(m),
    lead_days: leadDays(m),
    anchor: Number(m.recurrence_anchor) > 0 ? Number(m.recurrence_anchor) : null,
    slot: occurrenceSlot(m) || null,
    series: m.recurrence_series || id,
    previous: m.previous_occurrence || null,
    next: m.next_occurrence || null,
    series_notes: m.recurrence_notes !== undefined ? String(m.recurrence_notes) : null,
    upcoming: isUpcoming(m, now),
    opens_at: Number.isFinite(due) && due > 0 ? opensAtOf(m) : null,
  };
}

/** Series fields only recurrenceChanges writes on an update. */
export const RECURRENCE_KEYS = [
  'is_recurring', 'recurrence_pattern', 'recurrence_interval', 'recurrence_anchor', 'recurrence_slot', 'lead_days',
  'recurrence_notes', 'recurrence_series', 'previous_occurrence', 'next_occurrence', 'opens_at', 'series_notes',
] as const;

export interface RecurrenceUpdate {
  recurrence_pattern?: RecurrencePattern | 'none';
  recurrence_interval?: number;
  lead_days?: number;
  /** Replaces the series template (the notes each new occurrence starts with). */
  series_notes?: string;
  due_date?: number;
  notes?: string;
}

const needsDue = (id: string) => new RecurrenceError(`${id} is recurring and needs a due date: pass recurrence_pattern "none" to stop the series first`);

/**
 * The series metadata an update writes, judged on the task as it is now
 * (`cur`). Throws RecurrenceError for an update that makes no sense, so call
 * it before writing anything. Setting or changing the pattern (or the
 * interval) re-anchors the series at the task's due date, today when it has
 * none (as any series change on a recurring task with no due date does);
 * "none" stops it. A plain due-date move keeps the occurrence's slot.
 * opens_at follows the due date and lead time.
 */
export function recurrenceChanges(id: string, cur: Record<string, any>, u: RecurrenceUpdate): Record<string, any> {
  const { recurrence_pattern: p, recurrence_interval: iv, lead_days: ld, series_notes: sn } = u;
  if (p !== undefined && p !== 'none' && !isRecurrencePattern(p)) throw new RecurrenceError(`recurrence_pattern must be one of ${RECURRENCE_PATTERNS.join(', ')} or none`);
  if (iv !== undefined) checkInterval(iv);
  if (ld !== undefined) checkLeadDays(ld);
  if (sn !== undefined && typeof sn !== 'string') throw new RecurrenceError('series_notes must be a string');
  const series = iv !== undefined || ld !== undefined || sn !== undefined;
  const recurring = isRecurring(cur);
  if (p === 'none') {
    if (series) throw new RecurrenceError('recurrence_pattern "none" stops the series: leave out recurrence_interval, lead_days and series_notes');
    return truthy(cur.is_recurring) || cur.recurrence_pattern ? { is_recurring: false, recurrence_pattern: '', opens_at: 0 } : {};
  }
  if (p === undefined && !recurring) {
    if (series) throw new RecurrenceError(`${id} is not recurring: set recurrence_pattern first`);
    return {};
  }
  if (u.due_date === 0) {
    throw p === undefined ? needsDue(id) : new RecurrenceError('A recurring task needs a due date: don\'t clear the due date when setting recurrence_pattern');
  }

  const curDue = Number(cur.due_date) > 0 ? Number(cur.due_date) : 0;
  const due = u.due_date !== undefined ? u.due_date : curDue;
  const pattern = (p ?? cur.recurrence_pattern) as RecurrencePattern;
  const same = recurring && pattern === cur.recurrence_pattern;
  const out: Record<string, any> = {};
  if (p !== undefined || (iv !== undefined && iv !== recurrenceInterval(cur)) || (series && !(due > 0))) {
    const d = due > 0 ? due : todayDue();
    Object.assign(out, {
      is_recurring: true,
      recurrence_pattern: pattern,
      due_date: d,
      recurrence_anchor: d,
      recurrence_slot: d,
      recurrence_interval: iv ?? (same ? recurrenceInterval(cur) : 1),
      lead_days: ld ?? (same ? leadDays(cur) : DEFAULT_LEAD_DAYS[pattern]),
    });
    if (!recurring) {
      out.recurrence_notes = u.notes ?? cur.notes ?? '';
      out.recurrence_series = cur.recurrence_series || id;
    }
  } else {
    if (ld !== undefined) out.lead_days = ld;
    // An occurrence from before slots were stored keeps its slot when its due date moves.
    if (u.due_date !== undefined && curDue && !(Number(cur.recurrence_slot) > 0)) out.recurrence_slot = curDue;
  }
  if (sn !== undefined) out.recurrence_notes = sn;
  const finalDue = out.due_date ?? due;
  if (finalDue > 0 && (out.due_date !== undefined || out.lead_days !== undefined || u.due_date !== undefined || !(Number(cur.opens_at) > 0))) {
    out.opens_at = opensAt(finalDue, out.lead_days ?? leadDays(cur));
  }
  return out;
}
