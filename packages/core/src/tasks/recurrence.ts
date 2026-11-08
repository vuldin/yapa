/**
 * Recurring tasks. A series keeps its calendar slots: occurrence k (k >= 1)
 * is due at recurrence_anchor + k * interval periods, counted in local time
 * from the anchor (month, quarter and year steps keep the anchor's day of
 * month, clamped to the target month's last day). Completing an occurrence
 * creates the next one at the first slot strictly after max(its due date,
 * now). An occurrence is upcoming, and hidden from task lists, until
 * lead_days before the day it is due.
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

/** When an occurrence due at `due` opens: the start of its due day, `lead` days earlier (local time). */
export function opensAt(due: number, lead: number): number {
  const d = new Date(due * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() - lead).getTime() / 1000);
}

/** Upcoming: a pending occurrence of a recurring task that hasn't opened yet. Computed on read, never stored. */
export function isUpcoming(m: Record<string, any>, now = Math.floor(Date.now() / 1000)): boolean {
  const due = Number(m.due_date);
  return isRecurring(m) && due > 0 && (m.status ?? 'pending') === 'pending' && now < opensAt(due, leadDays(m));
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
  const due = Number(m.due_date);
  return `upcoming: due ${formatTaskDate(due)}, opens ${formatTaskDay(opensAt(due, leadDays(m)))}`;
}

/** "repeats weekly, opens 2 day(s) before it is due", or '' when not recurring. */
export function recurrenceNote(m: Record<string, any>): string {
  if (!isRecurring(m)) return '';
  const lead = leadDays(m);
  return `repeats ${describeRecurrence(m)}, ${lead ? `opens ${lead} day(s) before it is due` : 'opens on the day it is due'}`;
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

export interface RecurrenceUpdate {
  recurrence_pattern?: RecurrencePattern | 'none';
  recurrence_interval?: number;
  lead_days?: number;
  /** Replaces the series template (the notes each new occurrence starts with). */
  series_notes?: string;
  due_date?: number;
  notes?: string;
}

/**
 * The metadata an update writes for recurrence, judged on the task as it is
 * now (`cur`). Setting or changing the pattern (or the interval) re-anchors
 * the series at the task's due date, today when it has none; "none" stops it.
 */
export function recurrenceChanges(id: string, cur: Record<string, any>, u: RecurrenceUpdate): Record<string, any> {
  const { recurrence_pattern: p, recurrence_interval: iv, lead_days: ld, series_notes: sn } = u;
  const recurring = isRecurring(cur);
  if (p === undefined && iv === undefined && ld === undefined && sn === undefined) {
    if (u.due_date === 0 && recurring) throw new RecurrenceError(`${id} is recurring and needs a due date: pass recurrence_pattern "none" to stop the series first`);
    return {};
  }
  if (p === 'none') return { is_recurring: false, recurrence_pattern: '' };
  if (p !== undefined && !isRecurrencePattern(p)) throw new RecurrenceError(`recurrence_pattern must be one of ${RECURRENCE_PATTERNS.join(', ')} or none`);
  if (p === undefined && !recurring) throw new RecurrenceError(`${id} is not recurring: set recurrence_pattern first`);
  if (iv !== undefined) checkInterval(iv);
  if (ld !== undefined) checkLeadDays(ld);

  const pattern = (p ?? cur.recurrence_pattern) as RecurrencePattern;
  const same = recurring && pattern === cur.recurrence_pattern;
  const out: Record<string, any> = {};
  if (p !== undefined || (iv !== undefined && iv !== recurrenceInterval(cur))) {
    const given = u.due_date !== undefined ? u.due_date : Number(cur.due_date) || 0;
    const due = given > 0 ? given : todayDue();
    Object.assign(out, {
      is_recurring: true,
      recurrence_pattern: pattern,
      due_date: due,
      recurrence_anchor: due,
      recurrence_interval: iv ?? (same ? recurrenceInterval(cur) : 1),
      lead_days: ld ?? (same ? leadDays(cur) : DEFAULT_LEAD_DAYS[pattern]),
    });
    if (!recurring) {
      out.recurrence_notes = u.notes ?? cur.notes ?? '';
      out.recurrence_series = cur.recurrence_series || id;
    }
  } else {
    if (u.due_date === 0) throw new RecurrenceError(`${id} is recurring and needs a due date: pass recurrence_pattern "none" to stop the series first`);
    if (ld !== undefined) out.lead_days = ld;
  }
  if (sn !== undefined) out.recurrence_notes = sn;
  return out;
}
