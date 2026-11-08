import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore } from '../store/index.js';
import { createTask } from './create.js';
import { completeTask, getTask, updateTask } from './update.js';
import { listTasks } from './list.js';
import { nextTasks } from './next.js';
import { waitingOn } from './waiting.js';
import { requestDecision } from './close.js';
import { claimsFor } from './claim.js';
import { addDocument, getDocumentsByFilter, patchDocument } from '../store/index.js';
import {
  DEFAULT_LEAD_DAYS, isUpcoming, leadDays, metaNumber, nextRecurrenceDue, opensAt, opensAtOf, RECURRENCE_PATTERNS, recurrenceInterval, recurrenceLine,
  recurrenceSlot, todayDue, upcomingNote, type RecurrencePattern,
} from './recurrence.js';

const at = (y: number, m: number, d: number, h = 23, mi = 59, s = 59) => Math.floor(new Date(y, m - 1, d, h, mi, s).getTime() / 1000);
const day = (t: number) => { const d = new Date(t * 1000); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; };
const slots = (anchor: number, p: RecurrencePattern, interval: number, n: number) => Array.from({ length: n }, (_, i) => day(recurrenceSlot(anchor, p, interval, i + 1)));

describe('recurrence slots', () => {
  it('monthly counts from the anchor day and clamps to the month end', () => {
    expect(slots(at(2027, 1, 31), 'monthly', 1, 4)).toEqual([[2027, 2, 28], [2027, 3, 31], [2027, 4, 30], [2027, 5, 31]]);
    expect(slots(at(2028, 1, 31), 'monthly', 1, 1)).toEqual([[2028, 2, 29]]);
    expect(slots(at(2027, 1, 31), 'monthly', 2, 3)).toEqual([[2027, 3, 31], [2027, 5, 31], [2027, 7, 31]]);
  });

  it('quarterly and yearly clamp the same way, across year ends', () => {
    expect(slots(at(2026, 11, 30), 'quarterly', 1, 3)).toEqual([[2027, 2, 28], [2027, 5, 30], [2027, 8, 30]]);
    expect(slots(at(2028, 2, 29), 'yearly', 1, 4)).toEqual([[2029, 2, 28], [2030, 2, 28], [2031, 2, 28], [2032, 2, 29]]);
    expect(slots(at(2026, 12, 15), 'quarterly', 2, 2)).toEqual([[2027, 6, 15], [2027, 12, 15]]);
  });

  it('daily and weekly step in days, with an interval', () => {
    expect(slots(at(2027, 2, 27), 'daily', 1, 3)).toEqual([[2027, 2, 28], [2027, 3, 1], [2027, 3, 2]]);
    expect(slots(at(2027, 1, 4), 'weekly', 2, 2)).toEqual([[2027, 1, 18], [2027, 2, 1]]);
    expect(slots(at(2027, 1, 4), 'daily', 3, 2)).toEqual([[2027, 1, 7], [2027, 1, 10]]);
  });

  it('keeps the anchor\'s local time of day across a DST change', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const anchor = at(2027, 3, 10, 9, 0, 0);
      for (const p of ['daily', 'weekly'] as const) {
        const s = recurrenceSlot(anchor, p, 1, 7);
        expect(new Date(s * 1000).getHours()).toBe(9);
        expect(new Date(s * 1000).getTimezoneOffset()).not.toBe(new Date(anchor * 1000).getTimezoneOffset());
      }
      const fall = at(2027, 10, 31, 23, 59, 59);
      expect(new Date(recurrenceSlot(fall, 'weekly', 1, 1) * 1000).getHours()).toBe(23);
      expect(day(opensAt(at(2027, 3, 16), 7))).toEqual([2027, 3, 9]);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe('slots in the series time zone', () => {
  const withTz = <T>(tz: string, fn: () => T): T => {
    const saved = process.env.TZ;
    process.env.TZ = tz;
    try { return fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  };
  const iso = (t: number) => new Date(t * 1000).toISOString();

  it('a month-end series in Los Angeles gets the same slots whether the completer is there or on UTC', () => {
    // Jan 31 2027, 23:59:59 in Los Angeles (PST, UTC-8).
    const anchor = Date.UTC(2027, 1, 1, 7, 59, 59) / 1000;
    const zone = 'America/Los_Angeles';
    const there = withTz(zone, () => [1, 2, 3].map(k => iso(recurrenceSlot(anchor, 'monthly', 1, k, zone))));
    const utc = withTz('UTC', () => [1, 2, 3].map(k => iso(recurrenceSlot(anchor, 'monthly', 1, k, zone))));
    expect(utc).toEqual(there);
    // Feb 28 (PST), Mar 31 and Apr 30 (PDT, UTC-7), each at 23:59:59 local.
    expect(utc).toEqual(['2027-03-01T07:59:59.000Z', '2027-04-01T06:59:59.000Z', '2027-05-01T06:59:59.000Z']);
    // Without a zone, the UTC completer would count in UTC: the series moves.
    expect(withTz('UTC', () => iso(recurrenceSlot(anchor, 'monthly', 1, 2)))).not.toBe(utc[1]);
  });

  it('keeps the wall-clock time across a DST change, and opens at the zone\'s midnight', () => {
    const zone = 'America/New_York';
    const anchor = Date.UTC(2027, 2, 8, 14) / 1000; // Mon Mar 8 2027, 09:00 EST
    const slot = withTz('Asia/Tokyo', () => recurrenceSlot(anchor, 'weekly', 1, 1, zone));
    expect(iso(slot)).toBe('2027-03-15T13:00:00.000Z'); // 09:00 EDT after Mar 14
    expect(iso(withTz('UTC', () => opensAt(slot, 2, zone)))).toBe('2027-03-13T05:00:00.000Z'); // Sat Mar 13, 00:00 EST
  });
});

describe('metadata numbers', () => {
  it('accept integer JSON numbers and decimal strings only, as the remote SQL does', () => {
    expect(metaNumber(3)).toBe(3);
    expect(metaNumber(' 2 ')).toBe(2);
    expect(metaNumber('1.5e1')).toBe(15);
    for (const v of [true, false, '0x10', '', 'two', null, Infinity, 1e300, '1e999']) expect(metaNumber(v)).toBeUndefined();
    expect(metaNumber(1e-320)).toBe(0);
    expect(leadDays({ recurrence_pattern: 'weekly', lead_days: true })).toBe(2);
    expect(leadDays({ recurrence_pattern: 'weekly', lead_days: '0x10' })).toBe(2);
    expect(recurrenceInterval({ recurrence_interval: true })).toBe(1);
  });
});

describe('nextRecurrenceDue', () => {
  const anchor = at(2027, 1, 4);

  it('skips the slots missed by a late completion', () => {
    expect(day(nextRecurrenceDue(anchor, 'weekly', 1, at(2027, 1, 27, 10, 0, 0)))).toEqual([2027, 2, 1]);
    expect(day(nextRecurrenceDue(at(2027, 1, 31), 'monthly', 1, at(2027, 6, 2, 8)))).toEqual([2027, 6, 30]);
  });

  it('is strictly after: a completion on time or early takes the next slot', () => {
    const due = recurrenceSlot(anchor, 'weekly', 1, 1);
    expect(day(nextRecurrenceDue(anchor, 'weekly', 1, due))).toEqual([2027, 1, 18]);
    expect(day(nextRecurrenceDue(anchor, 'weekly', 1, anchor - 86400 * 30))).toEqual([2027, 1, 11]);
  });

  it('matches stepping through every slot, however far from the anchor', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 300; i++) {
      const p = RECURRENCE_PATTERNS[Math.floor(rand() * RECURRENCE_PATTERNS.length)];
      const interval = 1 + Math.floor(rand() * 3);
      const a = at(2020 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 31));
      const after = a + Math.floor(rand() * 4 * 365 * 86400);
      let k = 1;
      while (recurrenceSlot(a, p, interval, k) <= after) k++;
      expect(nextRecurrenceDue(a, p, interval, after)).toBe(recurrenceSlot(a, p, interval, k));
    }
  });
});

describe('recurring tasks over the store', () => {
  let dir: string;
  const C = 'project-reports';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yapa-recurrence-test-'));
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true' }));
    setStore(createLocalStore(dir));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    resetStore();
    resetConfig();
  });
  afterEach(() => { vi.useRealTimers(); });
  const now = (t: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(t * 1000); };

  describe('createTask', () => {
    it('stores the series fields, with today as due date and anchor when none is given', async () => {
      const id = await createTask('set up the monthly review', { recurrence_pattern: 'monthly', notes: 'agenda: numbers, risks' }, C);
      const m = (await getTask(id))!.metadata;
      expect(m).toMatchObject({
        is_recurring: true, recurrence_pattern: 'monthly', recurrence_interval: 1, lead_days: 7,
        due_date: todayDue(), recurrence_anchor: todayDue(), recurrence_notes: 'agenda: numbers, risks', recurrence_series: id,
      });
      expect(m.previous_occurrence).toBeUndefined();
    });

    it('defaults lead_days by pattern and refuses bad input', async () => {
      for (const p of RECURRENCE_PATTERNS) {
        const id = await createTask(`a ${p} chore`, { is_recurring: true, recurrence_pattern: p, due_date: at(2030, 1, 15) }, C);
        expect((await getTask(id))!.metadata.lead_days).toBe(DEFAULT_LEAD_DAYS[p]);
      }
      await expect(createTask('x', { is_recurring: true }, C)).rejects.toThrow(/recurrence_pattern/);
      await expect(createTask('x', { is_recurring: false, recurrence_pattern: 'weekly' }, C)).rejects.toThrow(/contradicts/);
      const { createTaskWithMetadata } = await import('./create.js');
      const made = await createTaskWithMetadata('a returned chore', { recurrence_pattern: 'daily', due_date: at(2030, 1, 15) }, C);
      expect(made).toMatchObject({ collection: C, metadata: { id: made.id, due_date: at(2030, 1, 15), recurrence_slot: at(2030, 1, 15), lead_days: 0 } });
      await expect(createTask('x', { recurrence_pattern: 'weekly', recurrence_interval: 0 }, C)).rejects.toThrow(/recurrence_interval/);
      await expect(createTask('x', { recurrence_pattern: 'weekly', lead_days: -1 }, C)).rejects.toThrow(/lead_days/);
    });

    it('leaves a plain task without series fields', async () => {
      const m = (await getTask(await createTask('a one-off', {}, C)))!.metadata;
      expect(m.is_recurring).toBe(false);
      expect(m.recurrence_anchor).toBeUndefined();
      expect(m.due_date).toBeUndefined();
    });
  });

  describe('completeTask', () => {
    it('starts the next occurrence from the template, linked to the series and the previous one', async () => {
      now(at(2027, 1, 13, 9));
      const first = await createTask('file the weekly report', {
        recurrence_pattern: 'weekly', recurrence_interval: 2, lead_days: 5, due_date: at(2027, 1, 15), notes: 'checklist: totals, sign-off', tags: ['reports'],
      }, C);
      await updateTask(first, { notes: 'checklist: totals, sign-off\nsent Jan 14, two figures late' });

      const r1 = await completeTask(first);
      expect(r1.next).toEqual({ due_date: at(2027, 1, 29), opens_at: at(2027, 1, 24, 0, 0, 0) });
      const second = (await getTask(r1.regeneratedId!))!.metadata;
      expect(second).toMatchObject({
        notes: 'checklist: totals, sign-off', recurrence_notes: 'checklist: totals, sign-off',
        recurrence_series: first, previous_occurrence: first, lead_days: 5, recurrence_interval: 2,
        recurrence_anchor: at(2027, 1, 15), due_date: at(2027, 1, 29), status: 'pending', tags: ['reports'],
      });

      now(at(2027, 1, 28, 9));
      const r2 = await completeTask(r1.regeneratedId!);
      expect((await getTask(r2.regeneratedId!))!.metadata).toMatchObject({ recurrence_series: first, previous_occurrence: r1.regeneratedId, due_date: at(2027, 2, 12) });
    });

    it('keeps the slot when completed late, skipping missed periods', async () => {
      now(at(2027, 1, 30, 10));
      const id = await createTask('reconcile the ledger', { recurrence_pattern: 'monthly', due_date: at(2026, 10, 31) }, C);
      const r = await completeTask(id);
      expect(day(r.next!.due_date)).toEqual([2027, 1, 31]);
      const late = await completeTask((await createTask('reconcile again', { recurrence_pattern: 'monthly', due_date: at(2026, 10, 31) }, C)));
      expect(late.next!.due_date).toBe(r.next!.due_date);
    });

    it('takes the slot after the due date when completed early', async () => {
      now(at(2027, 3, 1, 10));
      const id = await createTask('file the quarterly report', { recurrence_pattern: 'quarterly', due_date: at(2027, 3, 31) }, C);
      const r = await completeTask(id);
      expect(day(r.next!.due_date)).toEqual([2027, 6, 30]);
      expect(day(r.next!.opens_at)).toEqual([2027, 6, 16]);
    });

    it('gives a series created before templates its current notes', async () => {
      now(at(2027, 1, 4, 10));
      const { addDocument } = await import('../store/index.js');
      await addDocument(C, 'manual-900', 'water the plants', {
        type: 'task', id: 'manual-900', status: 'pending', priority: 'low', is_recurring: true, recurrence_pattern: 'weekly',
        due_date: at(2027, 1, 4), notes: 'back porch\ndone, soil was dry', tags: '', created_at: 1, updated_at: 1,
      });
      const r = await completeTask('manual-900');
      expect((await getTask(r.regeneratedId!))!.metadata).toMatchObject({
        notes: 'back porch\ndone, soil was dry', recurrence_anchor: at(2027, 1, 4), due_date: at(2027, 1, 11), recurrence_series: 'manual-900', lead_days: 2,
      });
    });
  });

  describe('upcoming', () => {
    const L = 'project-upcoming';
    it('hides recurring occurrences that have not opened yet from listTasks, task_next and waiting', async () => {
      now(at(2027, 5, 3, 12));
      const later = await createTask('renew the domain', { recurrence_pattern: 'yearly', due_date: at(2027, 6, 30) }, L);
      const soon = await createTask('send the weekly digest', { recurrence_pattern: 'weekly', due_date: at(2027, 5, 5) }, L);
      const blocked = await createTask('rotate the shared key', { recurrence_pattern: 'monthly', due_date: at(2027, 7, 1), status: 'blocked' }, L);
      const plain = await createTask('plan the offsite', { due_date: at(2028, 1, 1) }, L);
      const person = await createTask('approve the monthly budget', { recurrence_pattern: 'monthly', due_date: at(2027, 6, 30), tags: ['needs-human'] }, L);

      const ids = async (f = {}) => (await listTasks({ collection: L, ...f })).map(t => t.id).sort();
      expect(await ids()).toEqual([soon, blocked, plain].sort());
      expect(await ids({ includeUpcoming: true })).toEqual([later, soon, blocked, plain, person].sort());

      const next = await nextTasks({ collection: L });
      expect(next.ready.map(t => t.id).sort()).toEqual([soon, plain].sort());
      expect(next.skipped.map(s => s.id)).not.toContain(later);
      expect((await waitingOn({ collection: L })).actions.map(a => a.id)).toEqual([]);

      const m = (await getTask(later))!.metadata;
      expect(isUpcoming(m)).toBe(true);
      expect(upcomingNote(m)).toMatch(/^upcoming: due Wed, Jun 30, opens Mon, May 31$/);

      now(at(2027, 5, 31, 0, 0, 1));
      expect(await ids()).toContain(later);
      expect(await ids()).not.toContain(person);
      now(at(2027, 6, 23, 0, 0, 1));
      expect((await waitingOn({ collection: L })).actions.map(a => a.id)).toEqual([person]);
    });

    it('listTasksCounted says how many upcoming occurrences it left out', async () => {
      now(at(2027, 5, 3, 12));
      const { listTasksCounted } = await import('./list.js');
      expect((await listTasksCounted({ collection: L })).upcomingHidden).toBe(2);
      expect((await listTasksCounted({ collection: L, includeUpcoming: true })).upcomingHidden).toBe(0);
      expect((await listTasksCounted({ collection: L, status: 'blocked' })).upcomingHidden).toBe(0);
      const tagged = await listTasksCounted({ collection: L, tags: ['needs-human'] });
      expect(tagged).toMatchObject({ tasks: [], upcomingHidden: 1 });
    });

    it('getDueTasks keeps upcoming occurrences: the dashboard\'s "Upcoming (7 days)" shows them', async () => {
      now(at(2027, 5, 3, 12));
      const { getDueTasks } = await import('./list.js');
      const due = (await getDueTasks(true)).map(t => t.id);
      const ids = (await listTasks({ collection: L, includeUpcoming: true })).map(t => t.id);
      const upcoming = (await listTasks({ collection: L, includeUpcoming: true })).filter(t => isUpcoming(t.metadata)).map(t => t.id);
      expect(upcoming.length).toBeGreaterThan(0);
      for (const id of upcoming) expect(due).toContain(id);
      expect(ids.length).toBeGreaterThan(upcoming.length);
    });

    it('a lead-time change takes effect at once', async () => {
      now(at(2027, 5, 3, 12));
      const id = await createTask('review the access list', { recurrence_pattern: 'monthly', due_date: at(2027, 5, 31) }, 'project-lead');
      expect(await listTasks({ collection: 'project-lead' })).toHaveLength(0);
      await updateTask(id, { lead_days: 30 });
      expect((await listTasks({ collection: 'project-lead' })).map(t => t.id)).toEqual([id]);
    });

    it('a daily occurrence is open on its due day', async () => {
      now(at(2027, 5, 3, 8));
      const id = await createTask('check the backups', { recurrence_pattern: 'daily' }, 'project-daily');
      expect((await listTasks({ collection: 'project-daily' })).map(t => t.id)).toEqual([id]);
      const r = await completeTask(id);
      expect(r.next).toEqual({ due_date: at(2027, 5, 4), opens_at: at(2027, 5, 4, 0, 0, 0) });
      expect(await listTasks({ collection: 'project-daily' })).toHaveLength(0);
    });
  });

  describe('updateTask', () => {
    it('sets recurrence on a plain task: due today, anchored there, notes as the template', async () => {
      now(at(2027, 8, 2, 9));
      const id = await createTask('back up the laptop', { notes: 'external drive' }, C);
      await updateTask(id, { recurrence_pattern: 'weekly' });
      expect((await getTask(id))!.metadata).toMatchObject({
        is_recurring: true, recurrence_pattern: 'weekly', recurrence_interval: 1, lead_days: 2,
        due_date: at(2027, 8, 2), recurrence_anchor: at(2027, 8, 2), recurrence_notes: 'external drive', recurrence_series: id,
      });
    });

    it('changing the pattern re-anchors at the current due date and resets interval and lead', async () => {
      now(at(2027, 8, 2, 9));
      const id = await createTask('pay the invoices', { recurrence_pattern: 'weekly', recurrence_interval: 3, lead_days: 4, due_date: at(2027, 8, 6) }, C);
      await updateTask(id, { due_date: at(2027, 8, 13) });
      expect((await getTask(id))!.metadata.recurrence_anchor).toBe(at(2027, 8, 6));

      await updateTask(id, { recurrence_pattern: 'monthly' });
      expect((await getTask(id))!.metadata).toMatchObject({ recurrence_pattern: 'monthly', recurrence_anchor: at(2027, 8, 13), recurrence_interval: 1, lead_days: 7 });

      await updateTask(id, { recurrence_interval: 2, due_date: at(2027, 8, 31) });
      expect((await getTask(id))!.metadata).toMatchObject({ recurrence_anchor: at(2027, 8, 31), recurrence_interval: 2, lead_days: 7 });
      expect(day((await completeTask(id)).next!.due_date)).toEqual([2027, 10, 31]);
    });

    it('notes change this occurrence; series_notes the template', async () => {
      now(at(2027, 8, 2, 9));
      const id = await createTask('update the runbook', { recurrence_pattern: 'monthly', notes: 'sections 1-3', due_date: at(2027, 8, 20) }, C);
      await updateTask(id, { notes: 'sections 1-3, section 2 rewritten' });
      await updateTask(id, { series_notes: 'sections 1-4' });
      const m = (await getTask(id))!.metadata;
      expect(m.notes).toBe('sections 1-3, section 2 rewritten');
      expect(m.series_notes).toBeUndefined();
      const r = await completeTask(id);
      expect((await getTask(r.regeneratedId!))!.metadata.notes).toBe('sections 1-4');
    });

    it('"none" stops the series: completing creates no next occurrence', async () => {
      const id = await createTask('send the newsletter', { recurrence_pattern: 'weekly', due_date: at(2030, 8, 6) }, C);
      await updateTask(id, { recurrence_pattern: 'none' });
      const m = (await getTask(id))!.metadata;
      expect(m.is_recurring).toBe(false);
      expect(isUpcoming(m)).toBe(false);
      expect((await completeTask(id)).regeneratedId).toBeUndefined();
    });

    it('refuses recurrence fields on a plain task, bad values, and clearing a recurring task\'s due date', async () => {
      const plain = await createTask('a one-off', {}, C);
      await expect(updateTask(plain, { lead_days: 3 })).rejects.toThrow(/not recurring/);
      await expect(updateTask(plain, { series_notes: 'x' })).rejects.toThrow(/not recurring/);
      const rec = await createTask('a chore', { recurrence_pattern: 'weekly', due_date: at(2030, 1, 1) }, C);
      await expect(updateTask(rec, { recurrence_interval: 0 })).rejects.toThrow(/recurrence_interval/);
      await expect(updateTask(rec, { recurrence_pattern: 'hourly' as any })).rejects.toThrow(/recurrence_pattern/);
      await expect(updateTask(rec, { due_date: 0 })).rejects.toThrow(/needs a due date/);
      expect((await getTask(rec))!.metadata.due_date).toBe(at(2030, 1, 1));
    });
  });

  describe('review fixes', () => {
    const R = 'private-review';

    it('an occurrence moved earlier and completed keeps its slot: the next one is the slot after it', async () => {
      now(at(2027, 11, 1, 9));
      const first = await createTask('publish the weekly notes', { recurrence_pattern: 'weekly', due_date: at(2027, 11, 1) }, R);
      const second = (await completeTask(first)).regeneratedId!;
      expect((await getTask(second))!.metadata).toMatchObject({ due_date: at(2027, 11, 8), recurrence_slot: at(2027, 11, 8) });

      await updateTask(second, { due_date: at(2027, 11, 6) });
      const moved = (await getTask(second))!.metadata;
      expect(moved).toMatchObject({ due_date: at(2027, 11, 6), recurrence_slot: at(2027, 11, 8), opens_at: at(2027, 11, 4, 0, 0, 0) });
      now(at(2027, 11, 6, 10));
      expect(day((await completeTask(second)).next!.due_date)).toEqual([2027, 11, 15]);
    });

    it('an occurrence from before slots were stored keeps its due date as its slot when moved', async () => {
      now(at(2027, 11, 1, 9));
      await addDocument(R, 'manual-950', 'sweep the porch', {
        type: 'task', id: 'manual-950', status: 'pending', is_recurring: true, recurrence_pattern: 'weekly', due_date: at(2027, 11, 8), created_at: 1, updated_at: 1,
      });
      await updateTask('manual-950', { due_date: at(2027, 11, 6) });
      expect((await getTask('manual-950'))!.metadata.recurrence_slot).toBe(at(2027, 11, 8));
      now(at(2027, 11, 6, 10));
      expect(day((await completeTask('manual-950')).next!.due_date)).toEqual([2027, 11, 15]);
    });

    it('stores opens_at on create, on lead and due changes and at regeneration; clears it on stop; ignores a stale one', async () => {
      now(at(2027, 11, 1, 9));
      const id = await createTask('review the budget', { recurrence_pattern: 'monthly', due_date: at(2027, 11, 30) }, R);
      expect((await getTask(id))!.metadata.opens_at).toBe(at(2027, 11, 23, 0, 0, 0));
      await updateTask(id, { lead_days: 3 });
      expect((await getTask(id))!.metadata.opens_at).toBe(at(2027, 11, 27, 0, 0, 0));
      await updateTask(id, { due_date: at(2027, 11, 20) });
      expect((await getTask(id))!.metadata.opens_at).toBe(at(2027, 11, 17, 0, 0, 0));

      // A client that doesn't store opens_at moves the due date: the stale value is ignored.
      await patchDocument(R, id, { due_date: at(2027, 11, 28) });
      expect(opensAtOf((await getTask(id))!.metadata)).toBe(at(2027, 11, 25, 0, 0, 0));
      // One written in another time zone (a few hours off) is kept.
      expect(opensAtOf({ ...(await getTask(id))!.metadata, opens_at: at(2027, 11, 25, 5, 0, 0) })).toBe(at(2027, 11, 25, 5, 0, 0));

      const r = await completeTask(id);
      expect((await getTask(r.regeneratedId!))!.metadata.opens_at).toBe(r.next!.opens_at);
      await updateTask(r.regeneratedId!, { recurrence_pattern: 'none' });
      expect((await getTask(r.regeneratedId!))!.metadata).toMatchObject({ is_recurring: false, opens_at: 0 });
    });

    it('validates every recurrence field on every path, and refuses stopping while setting series fields', async () => {
      const id = await createTask('archive the logs', { recurrence_pattern: 'weekly', due_date: at(2030, 3, 4) }, R);
      await expect(updateTask(id, { recurrence_pattern: 'none', lead_days: 3 })).rejects.toThrow(/stops the series/);
      await expect(updateTask(id, { recurrence_pattern: 'none', series_notes: 'x' })).rejects.toThrow(/stops the series/);
      await expect(updateTask(id, { recurrence_pattern: 'none', recurrence_interval: 0 })).rejects.toThrow(/recurrence_interval/);
      await expect(updateTask(id, { lead_days: 1.5 })).rejects.toThrow(/lead_days/);
      const plain = await createTask('a one-off to make recurring', {}, R);
      await expect(updateTask(plain, { recurrence_pattern: 'weekly', due_date: 0 })).rejects.toThrow(/don't clear the due date when setting recurrence_pattern/);
      expect((await getTask(plain))!.metadata.is_recurring).toBe(false);
      expect((await getTask(id))!.metadata).toMatchObject({ is_recurring: true, lead_days: 2 });
      await updateTask(id, { recurrence_pattern: 'none' });
      expect((await getTask(id))!.metadata.lead_days).toBe(2);
    });

    it('one successor: reopening and completing again finds it, two completions at once create one', async () => {
      now(at(2027, 11, 1, 9));
      const id = await createTask('rotate the backup tapes', { recurrence_pattern: 'weekly' }, R);
      const first = await completeTask(id);
      expect((await getTask(id))!.metadata.next_occurrence).toBe(first.regeneratedId);
      await updateTask(id, { status: 'pending' });
      expect(await completeTask(id)).toMatchObject({ existingNext: first.regeneratedId });
      expect((await getDocumentsByFilter(R, { type: 'task' }, 1000)).filter(d => d.metadata.previous_occurrence === id)).toHaveLength(1);

      const both = await Promise.all([completeTask(first.regeneratedId!), completeTask(first.regeneratedId!)]);
      expect(both.filter(r => r.regeneratedId)).toHaveLength(1);
      const children = (await getDocumentsByFilter(R, { type: 'task' }, 1000)).filter(d => d.metadata.previous_occurrence === first.regeneratedId);
      expect(children).toHaveLength(1);
    });

    it('keeps a title and a template that look like JSON as they are', async () => {
      now(at(2027, 11, 1, 9));
      const id = await createTask('[2026] plan the offsite', { recurrence_pattern: 'yearly', notes: '["venue","catering"]' }, R);
      expect((await getTask(id))!.metadata).toMatchObject({ title: '[2026] plan the offsite', notes: '["venue","catering"]', recurrence_notes: '["venue","catering"]' });
      const r = await completeTask(id);
      const next = (await getTask(r.regeneratedId!))!;
      expect(next.title).toBe('[2026] plan the offsite');
      expect(next.metadata).toMatchObject({ notes: '["venue","catering"]', recurrence_notes: '["venue","catering"]' });
    });

    it('refuses recurrence_interval or lead_days at create without a pattern', async () => {
      await expect(createTask('x', { lead_days: 3 }, R)).rejects.toThrow(/need a recurrence_pattern/);
      await expect(createTask('x', { recurrence_interval: 2 }, R)).rejects.toThrow(/need a recurrence_pattern/);
    });

    it('refuses series changes on a completed occurrence, naming the open one', async () => {
      now(at(2027, 11, 1, 9));
      const id = await createTask('reconcile the petty cash', { recurrence_pattern: 'weekly' }, R);
      const second = (await completeTask(id)).regeneratedId!;
      const third = (await completeTask(second)).regeneratedId!;
      for (const u of [{ lead_days: 1 }, { series_notes: 'x' }, { recurrence_pattern: 'none' as const }, { recurrence_interval: 2 }]) {
        await expect(updateTask(id, u)).rejects.toThrow(new RegExp(`${id} isn't the open occurrence of its series: change the series on ${third}`));
      }
      await updateTask(third, { recurrence_pattern: 'none' });
      await completeTask(third);
      await expect(updateTask(third, { lead_days: 1 })).rejects.toThrow(/is complete and no open occurrence follows it/);
      await expect(updateTask(id, { notes: 'a note on the done one' })).resolves.toBeDefined();
    });

    it('a re-anchor keeps the series\' zone: a Berlin editor changing a New York series', async () => {
      const saved = process.env.TZ;
      try {
        process.env.TZ = 'America/New_York';
        const id = await createTask('call the New York office', { recurrence_pattern: 'weekly', due_date: Date.UTC(2027, 2, 8, 14) / 1000 }, R);
        expect((await getTask(id))!.metadata.recurrence_tz).toBe('America/New_York');
        process.env.TZ = 'Europe/Berlin';
        await updateTask(id, { recurrence_pattern: 'monthly' });
        const m = (await getTask(id))!.metadata;
        expect(m.recurrence_tz).toBe('America/New_York');
        // Mar 8 09:00 in New York, a month on: Apr 8 09:00 EDT.
        expect(new Date(recurrenceSlot(m.recurrence_anchor, 'monthly', 1, 1, m.recurrence_tz) * 1000).toISOString()).toBe('2027-04-08T13:00:00.000Z');
      } finally {
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
      }
    });

    it('a bogus due date reads as none: true or "0x10"', async () => {
      now(at(2027, 11, 3, 9));
      for (const [i, bogus] of [true, '0x10'].entries()) {
        const id = `manual-98${i}`;
        await addDocument(R, id, 'test the alarm', { type: 'task', id, status: 'pending', is_recurring: true, recurrence_pattern: 'weekly', due_date: bogus, created_at: 1, updated_at: 1 });
        expect(isUpcoming((await getTask(id))!.metadata)).toBe(false);
        await updateTask(id, { lead_days: 1 });
        expect((await getTask(id))!.metadata).toMatchObject({ due_date: at(2027, 11, 3), recurrence_anchor: at(2027, 11, 3), lead_days: 1 });
      }
    });

    it('a recurring task created here records this machine\'s zone', async () => {
      const id = await createTask('wind the clocks', { recurrence_pattern: 'monthly', due_date: at(2030, 1, 31) }, R);
      expect((await getTask(id))!.metadata.recurrence_tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });

    it('a refused recurrence change takes no claim', async () => {
      const id = await createTask('a one-off', {}, R);
      await expect(updateTask(id, { status: 'in_progress', lead_days: 3 }, { session: 's-review' })).rejects.toThrow(/not recurring/);
      expect((await claimsFor(R))?.get(id)).toBeUndefined();
      expect((await getTask(id))!.metadata.status).toBe('pending');
    });

    it('decision_needed with an update that would be refused stores no decision', async () => {
      const id = await createTask('choose the vendor review cadence', { recurrence_pattern: 'quarterly', due_date: at(2030, 3, 31) }, R);
      await expect(requestDecision(id, { question: 'Keep it quarterly?', options: ['yes', 'no'] }, {}, { due_date: 0 })).rejects.toThrow(/needs a due date/);
      expect(await getDocumentsByFilter(R, { type: 'memory', kind: 'decision' }, 100)).toHaveLength(0);
    });

    it('completeTask applies other fields first, so a series_notes change reaches the next occurrence', async () => {
      now(at(2027, 11, 1, 9));
      const id = await createTask('update the checklist', { recurrence_pattern: 'weekly', notes: 'v1' }, R);
      const r = await completeTask(id, undefined, {}, {}, { series_notes: 'v2', status: 'complete' });
      expect((await getTask(r.regeneratedId!))!.metadata.notes).toBe('v2');
      expect((await getTask(id))!.metadata).toMatchObject({ status: 'complete', recurrence_notes: 'v2' });
      expect(r.metadata).toMatchObject({ status: 'complete', recurrence_notes: 'v2' });
      await expect(completeTask(r.regeneratedId!, undefined, {}, {}, { lead_days: -1 })).rejects.toThrow(/lead_days/);
      expect((await getTask(r.regeneratedId!))!.metadata.status).toBe('pending');
      const renamed = await completeTask(r.regeneratedId!, undefined, {}, {}, { title: 'update the release checklist' });
      expect((await getTask(renamed.regeneratedId!))!.title).toBe('update the release checklist');
      const stop = await createTask('update it once more', { recurrence_pattern: 'weekly' }, R);
      expect((await completeTask(stop, undefined, {}, {}, { recurrence_pattern: 'none' })).regeneratedId).toBeUndefined();
    });

    it('a series change on a recurring task with no due date gives it today; the reply line never shows an invalid date', async () => {
      now(at(2027, 11, 3, 9));
      await addDocument(R, 'manual-960', 'oil the hinges', {
        type: 'task', id: 'manual-960', status: 'pending', is_recurring: true, recurrence_pattern: 'monthly', created_at: 1, updated_at: 1,
      });
      expect(recurrenceLine((await getTask('manual-960'))!.metadata)).toBe('Repeats monthly, opens 7 day(s) before it is due.');
      await updateTask('manual-960', { lead_days: 1 });
      expect((await getTask('manual-960'))!.metadata).toMatchObject({ due_date: at(2027, 11, 3), recurrence_anchor: at(2027, 11, 3), recurrence_slot: at(2027, 11, 3), lead_days: 1 });
      expect(recurrenceLine((await getTask('manual-960'))!.metadata)).not.toMatch(/Invalid/);
    });
  });
});
