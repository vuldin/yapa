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

/** This machine's IANA time zone, stored with a series when it is anchored (recurrence_tz). */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The series' stored time zone string, whether or not this machine knows it. */
export const storedZone = (m: Record<string, any>): string | undefined =>
  typeof m.recurrence_tz === 'string' && m.recurrence_tz ? m.recurrence_tz : undefined;

/** The zone to count the series in: its stored zone if this machine knows it, else undefined (local time; a series from before 1.19, or an unknown zone). */
export const seriesZone = (m: Record<string, any>): string | undefined => {
  const tz = storedZone(m);
  return tz && zoneFormatter(tz) ? tz : undefined;
};

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function zoneFormatter(tz: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tz)) {
    try {
      formatters.set(tz, new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      }));
    } catch {
      formatters.set(tz, null);
    }
  }
  return formatters.get(tz)!;
}

/** Wall-clock fields (month 0-based); fields may overflow on the way back, as with Date. */
interface Wall { y: number; m: number; d: number; h: number; mi: number; s: number }

function wallClock(t: number, tz?: string): Wall {
  const f = tz ? zoneFormatter(tz) : null;
  if (!f) {
    const a = new Date(t * 1000);
    return { y: a.getFullYear(), m: a.getMonth(), d: a.getDate(), h: a.getHours(), mi: a.getMinutes(), s: a.getSeconds() };
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t * 1000))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, m: p.month - 1, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** Unix seconds of a wall-clock time in `tz` (local time without one), corrected for the zone's offset at that time. */
function fromWallClock(w: Wall, tz?: string): number {
  const f = tz ? zoneFormatter(tz) : null;
  if (!f) return Math.floor(new Date(w.y, w.m, w.d, w.h, w.mi, w.s).getTime() / 1000);
  const asUtc = Date.UTC(w.y, w.m, w.d, w.h, w.mi, w.s) / 1000;
  const offset = (t: number) => { const x = wallClock(t, tz); return Date.UTC(x.y, x.m, x.d, x.h, x.mi, x.s) / 1000 - t; };
  const first = offset(asUtc);
  const t = asUtc - first;
  const second = offset(t);
  return second === first ? t : asUtc - second;
}

/** Slot k of a series (unix seconds), counted in the series' zone (local time without one). */
export function recurrenceSlot(anchor: number, pattern: RecurrencePattern, interval: number, k: number, tz?: string): number {
  const a = wallClock(anchor, tz);
  const steps = k * interval;
  let { y, m, d } = a;
  if (MONTHS[pattern]) {
    m += steps * MONTHS[pattern]!;
    d = Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  } else {
    d += steps * DAYS[pattern]!;
  }
  return fromWallClock({ y, m, d, h: a.h, mi: a.mi, s: a.s }, tz);
}

/** The first slot of the series strictly after `after`. */
export function nextRecurrenceDue(anchor: number, pattern: RecurrencePattern, interval: number, after: number, tz?: string): number {
  let k = Math.max(1, Math.floor((after - anchor) / (MAX_PERIOD[pattern] * interval)));
  let slot = recurrenceSlot(anchor, pattern, interval, k, tz);
  while (slot <= after) slot = recurrenceSlot(anchor, pattern, interval, ++k, tz);
  return slot;
}

/** Decimal numbers as stored in a string: no more than 20 digits a side and a two-digit exponent, so never out of float8's range. */
export const NUMERIC_PATTERN = '^\\s*[-+]?([0-9]{1,20}(\\.[0-9]{0,20})?|\\.[0-9]{1,20})([eE][-+]?[0-9]{1,2})?\\s*$';
const NUMERIC = new RegExp(NUMERIC_PATTERN);

/**
 * A metadata number: a JSON number (one too small for float8 is 0, one of
 * 1e300 or more is missing), or a string matching NUMERIC_PATTERN. Anything
 * else (a boolean, hex, other text) is missing. The remote SQL reads them the same way.
 */
export function metaNumber(v: unknown): number | undefined {
  if (typeof v === 'number') {
    const a = Math.abs(v);
    return !Number.isFinite(v) || a >= 1e300 ? undefined : a < 1e-300 ? 0 : v;
  }
  return typeof v === 'string' && NUMERIC.test(v) ? Number(v) : undefined;
}

const truthy = (v: unknown) => v === true || v === 'true';
const nonNegInt = (v: unknown): number | undefined => {
  const n = metaNumber(v);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
};
/** A positive metadata time (unix seconds), else 0. */
export const metaTime = (v: unknown): number => { const n = metaNumber(v); return n !== undefined && n > 0 ? n : 0; };

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
  return metaTime(m.recurrence_slot) || metaTime(m.due_date);
}

/** When an occurrence due at `due` opens: the start of its due day, `lead` days earlier, in `tz` (local time without one). */
export function opensAt(due: number, lead: number, tz?: string): number {
  const w = wallClock(due, tz);
  return fromWallClock({ y: w.y, m: w.m, d: w.d - lead, h: 0, mi: 0, s: 0 }, tz);
}

/**
 * The opening time stored when the task was written (`opens_at`), if it
 * still fits the due date and lead time: within the day before the due
 * date, lead_days earlier. Undefined when absent or stale (a due date moved
 * by a client that doesn't store it).
 */
export function storedOpensAt(m: Record<string, any>): number | undefined {
  const stored = metaTime(m.opens_at), due = metaTime(m.due_date);
  if (!stored || !due) return undefined;
  const lead = leadDays(m);
  return stored <= due - lead * 86400 + 3600 && stored > due - (lead + 1) * 86400 - 3600 ? stored : undefined;
}

/** How an opening time is worked out when none is stored: (due, lead) -> unix seconds. */
export type OpeningRule = (due: number, lead: number) => number;

/** When this occurrence opens: as stored, else by `fallback` (default: opensAt in the series' zone). */
export function opensAtOf(m: Record<string, any>, fallback?: OpeningRule): number {
  const due = metaTime(m.due_date), lead = leadDays(m);
  return storedOpensAt(m) ?? (fallback ? fallback(due, lead) : opensAt(due, lead, seriesZone(m)));
}

/**
 * The one upcoming rule: for a recurring task with a due date, when it opens
 * and whether that is still ahead of `now` for a pending occurrence (it is
 * upcoming); undefined for any other task.
 */
export function openingOf(m: Record<string, any>, now = Math.floor(Date.now() / 1000), fallback?: OpeningRule): { opens_at: number; upcoming: boolean } | undefined {
  if (!isRecurring(m) || !metaTime(m.due_date)) return undefined;
  const opens = opensAtOf(m, fallback);
  return { opens_at: opens, upcoming: (m.status ?? 'pending') === 'pending' && now < opens };
}

/** Upcoming: a pending occurrence of a recurring task that hasn't opened yet. */
export function isUpcoming(m: Record<string, any>, now = Math.floor(Date.now() / 1000), fallback?: OpeningRule): boolean {
  return openingOf(m, now, fallback)?.upcoming ?? false;
}

/** "weekly", "every 2 months". */
export function describeRecurrence(m: Record<string, any>): string {
  const n = recurrenceInterval(m);
  if (n === 1) return String(m.recurrence_pattern);
  const unit = { daily: 'days', weekly: 'weeks', monthly: 'months', quarterly: 'quarters', yearly: 'years' }[m.recurrence_pattern as RecurrencePattern];
  return `every ${n} ${unit}`;
}

/**
 * For a listing: when an upcoming occurrence opens, and the note
 * "upcoming: due Fri, Nov 14, opens Wed, Nov 12"; undefined when the task is
 * open. The opening time is worked out once.
 */
export function upcomingInfo(m: Record<string, any>, now = Math.floor(Date.now() / 1000)): { opens_at: number; note: string } | undefined {
  const o = openingOf(m, now);
  return o?.upcoming ? { opens_at: o.opens_at, note: `upcoming: due ${formatTaskDate(metaTime(m.due_date))}, opens ${formatTaskDay(o.opens_at)}` } : undefined;
}

/** upcomingInfo's note, or '' when the task is open. */
export const upcomingNote = (m: Record<string, any>, now = Math.floor(Date.now() / 1000)): string => upcomingInfo(m, now)?.note ?? '';

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
  const due = metaTime(m.due_date);
  if (!due) return `${head}.`;
  const upcoming = upcomingInfo(m, now);
  const when = upcoming ? `opens ${formatTaskDay(upcoming.opens_at)} (hidden from task lists until then)` : 'open now';
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
  /** The zone its slots are counted in; null: local time (a series from before 1.19). */
  zone: string | null;
  upcoming: boolean;
  opens_at: number | null;
}

/** A task's series, for listings and JSON; null when it isn't recurring. */
export function seriesInfo(m: Record<string, any>, id: string, now = Math.floor(Date.now() / 1000)): SeriesInfo | null {
  if (!isRecurring(m)) return null;
  const o = openingOf(m, now);
  return {
    pattern: m.recurrence_pattern,
    interval: recurrenceInterval(m),
    lead_days: leadDays(m),
    anchor: metaTime(m.recurrence_anchor) || null,
    slot: occurrenceSlot(m) || null,
    series: m.recurrence_series || id,
    previous: m.previous_occurrence || null,
    next: m.next_occurrence || null,
    series_notes: m.recurrence_notes !== undefined ? String(m.recurrence_notes) : null,
    zone: seriesZone(m) ?? null,
    upcoming: o?.upcoming ?? false,
    opens_at: o?.opens_at ?? null,
  };
}

/** Series fields only recurrenceChanges writes on an update. */
export const RECURRENCE_KEYS = [
  'is_recurring', 'recurrence_pattern', 'recurrence_interval', 'recurrence_anchor', 'recurrence_slot', 'recurrence_tz', 'lead_days',
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

  const curDue = metaTime(cur.due_date);
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
      // A re-anchor keeps the series' zone: an editor elsewhere doesn't move it.
      recurrence_tz: storedZone(cur) ?? localZone(),
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
    if (u.due_date !== undefined && curDue && !metaTime(cur.recurrence_slot)) out.recurrence_slot = curDue;
  }
  if (sn !== undefined) out.recurrence_notes = sn;
  const finalDue = out.due_date ?? due;
  if (finalDue > 0 && (out.due_date !== undefined || out.lead_days !== undefined || u.due_date !== undefined || !metaTime(cur.opens_at))) {
    out.opens_at = opensAt(finalDue, out.lead_days ?? leadDays(cur), out.recurrence_tz ?? seriesZone(cur));
  }
  return out;
}
