import { describe, it, expect } from 'vitest';
import { parseFollowThrough, type OpenItem } from './follow-through.js';
import { resolveOwner, ownerWaitsOn, includesUser } from '../memory/owners.js';

const finding: OpenItem = { id: 'mem-f', collection: 'project-acme', kind: 'finding', status: 'open', content: 'purge() rejects the purged_copies status' };
const question: OpenItem = { id: 'mem-q', collection: 'project-acme', kind: 'question', status: 'open', content: 'Which region does the customer run in?' };
const decision: OpenItem = { id: 'mem-d', collection: 'project-acme', kind: 'decision', status: 'needed', content: 'Ship Friday or wait?', options: ['Friday', 'wait'] };
const turn = (text: string, knownUsers: string[] = []) => ({ text, knownUsers });
const reply = (...changes: object[]) => JSON.stringify(changes);

describe('parseFollowThrough guards', () => {
  it('drops an item the turn does not address, even with a valid no-action disposition', () => {
    const t = turn("merged 75, now 74 has conflicts\nResolved #74's conflicts with main after #75 merged: CHANGELOG kept both sides, bundles rebuilt.");
    const raw = reply({
      id: 'mem-f', status: 'resolved', note: 'The turn does not address the purged_copies finding; it only reports resolving PR #74 conflicts after #75 merged.',
      evidence: "Resolved #74's conflicts with main after #75 merged", disposition: 'no-action',
      disposition_reason: 'The turn is about merge conflict resolution for PR #74 and does not decide what becomes of the purge status-handling finding.',
    });
    expect(parseFollowThrough(raw, [finding], 'josh', t)).toEqual([]);
  });

  it('keeps a close whose note only says something else was unrelated', () => {
    const t = turn('the lag spike was unrelated to the upgrade, close it');
    for (const note of [
      'No action: the lag spike was unrelated to the upgrade.',
      'Answered: the restart did not address the lag; the root cause is the quota.',
      'Closed: RF=3 is not covered by the SLA, so the limit no longer applies.',
      'Resolved: the fix does not touch the consumer path, so no follow-up needed.',
    ]) {
      const raw = reply({ id: 'mem-f', status: 'resolved', note, evidence: 'the lag spike was unrelated to the upgrade', disposition: 'no-action', disposition_reason: note });
      expect(parseFollowThrough(raw, [finding], 'josh', t)).toHaveLength(1);
    }
    const raw = reply({ id: 'mem-f', status: 'resolved', note: 'Not addressed in this turn.', evidence: 'the lag spike was unrelated to the upgrade', disposition: 'no-action', disposition_reason: 'n/a' });
    expect(parseFollowThrough(raw, [finding], 'josh', t)).toEqual([]);
  });

  it('accepts a short reply quoted whole, and quotes the model reformatted lightly', () => {
    const d = { ...decision, owner: 'josh' };
    const short = (userText: string, evidence: string) =>
      parseFollowThrough(reply({ id: 'mem-d', status: 'accepted', note: 'Friday', evidence }), [d], 'josh', { text: `${userText}\nOK.`, userText, knownUsers: ['josh'] });
    expect(short('yes', 'yes')).toHaveLength(1);
    expect(short('go with B', 'go with B.')).toHaveLength(1);
    expect(short('Yes, go with Friday', 'go with Friday')).toHaveLength(1);
    expect(short('a long reply that talks about many other things', 'yes')).toEqual([]);
    expect(short('not now, later', 'no')).toEqual([]);
    expect(short('yes', 'e')).toEqual([]);
    expect(short('Yes, go with Friday', 'yes')).toHaveLength(1);
    const t = { text: 'use the **quota** fix — then redeploy', userText: '', knownUsers: [] };
    expect(parseFollowThrough(reply({ id: 'mem-q', status: 'answered', note: 'quota', evidence: 'use the quota fix - then redeploy' }), [question], 'josh', t)).toHaveLength(1);
  });

  it('needs evidence that is really in the turn', () => {
    const t = turn('The customer confirmed they run in us-east-2.');
    const ok = { id: 'mem-q', status: 'answered', note: 'us-east-2' };
    expect(parseFollowThrough(reply(ok), [question], 'josh', t)).toEqual([]);
    expect(parseFollowThrough(reply({ ...ok, evidence: 'they run in eu-west-1' }), [question], 'josh', t)).toEqual([]);
    expect(parseFollowThrough(reply({ ...ok, evidence: 'run' }), [question], 'josh', t)).toEqual([]);
    expect(parseFollowThrough(reply({ ...ok, evidence: '"The customer  confirmed they run in US-EAST-2..."' }), [question], 'josh', t))
      .toEqual([{ id: 'mem-q', status: 'answered', note: 'us-east-2' }]);
  });

  it('answers a question owned by another YAPA user only in that user\'s turn', () => {
    const t = turn('alex says it is us-east-2', ['josh', 'alex']);
    const raw = reply({ id: 'mem-q', status: 'answered', note: 'us-east-2', evidence: 'alex says it is us-east-2' });
    expect(parseFollowThrough(raw, [{ ...question, owner: 'Alex' }], 'josh', t)).toEqual([]);
    expect(parseFollowThrough(raw, [{ ...question, owner: 'Alex' }], 'alex', t)).toHaveLength(1);
    expect(parseFollowThrough(raw, [{ ...question, owner: 'the platform team' }], 'josh', t)).toHaveLength(1);
  });

  it('settles a decision with an owner only in that owner\'s turn', () => {
    const t = turn('Go with Friday.', ['josh']);
    const raw = reply({ id: 'mem-d', status: 'accepted', note: 'Friday', evidence: 'Go with Friday.' });
    expect(parseFollowThrough(raw, [{ ...decision, owner: 'Josh' }], 'josh', t)).toHaveLength(1);
    expect(parseFollowThrough(raw, [{ ...decision, owner: 'josh' }], 'alex', t)).toEqual([]);
    expect(parseFollowThrough(raw, [{ ...decision, owner: 'Dana' }], 'josh', t)).toEqual([]);
    expect(parseFollowThrough(raw, [decision], 'alex', t)).toHaveLength(1);
  });
});

describe('owners', () => {
  const users = ['josh', 'alex'];
  it('resolves a YAPA user by name or email, case-insensitively', () => {
    expect(resolveOwner('Josh', users)).toEqual({ user: 'josh' });
    expect(resolveOwner('@alex', users)).toEqual({ user: 'alex' });
    expect(resolveOwner('JOSH@example.com', users)).toEqual({ user: 'josh' });
    expect(resolveOwner(' TI team ', users)).toEqual({ external: 'TI team' });
    expect(resolveOwner('', users)).toEqual({});
    expect(resolveOwner(undefined, users)).toEqual({});
  });

  it('sends an item for someone outside YAPA to whoever recorded it', () => {
    expect(ownerWaitsOn('Josh', 'alex', users)).toEqual({ for: ['josh'] });
    expect(ownerWaitsOn('Dana', 'alex', users)).toEqual({ for: ['alex'], ask: 'Dana' });
    expect(ownerWaitsOn('Dana', undefined, users)).toEqual({ for: [], ask: 'Dana' });
    expect(ownerWaitsOn(undefined, 'alex', users)).toEqual({ for: [] });
    expect(includesUser(['Josh'], 'josh')).toBe(true);
  });
});

describe('findOpenItems', () => {
  it('judges what the turn is about, not every item a long-running held task collected', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { setConfig, resetConfig, createConfig } = await import('../config.js');
    const { setStore, resetStore, createLocalStore } = await import('../store/index.js');
    const { storeMemory } = await import('../memory/store.js');
    const { createTask } = await import('../tasks/create.js');
    const { updateTask } = await import('../tasks/update.js');
    const { findOpenItems } = await import('./follow-through.js');
    const dir = mkdtempSync(join(tmpdir(), 'yapa-ft-items-'));
    setConfig(createConfig({ YAPA_USERNAME: 'josh' }));
    setStore(createLocalStore(dir));
    try {
      const C = 'project-acme';
      const task = await createTask('Ship the importer', {}, C);
      const old: string[] = [];
      for (let i = 0; i < 10; i++) {
        old.push((await storeMemory(`Importer finding ${i}: batch ${i} retries on shard ${i} time out after ${i + 3} seconds.`, {
          collection: C, typed: { kind: 'finding', task_ids: [task] },
        })).ids[0]);
      }
      const { ids: [waiting] } = await storeMemory('Ship the importer on Friday, or wait for the retry fix?', {
        collection: C, typed: { kind: 'decision', status: 'needed', owner: 'josh', options: ['Friday', 'wait'] },
      });
      await updateTask(task, { waits_on: [waiting] } as any);
      const { ids: [question] } = await storeMemory('Which region does the billing export run in?', { collection: C, typed: { kind: 'question' } });

      const items = await findOpenItems(C, 'Which region does the billing export run in? It runs in us-east-2.', [task]);
      expect(items[0].id).toBe(waiting);
      expect(items.map(i => i.id)).toContain(question);
      expect(items.length).toBeLessThanOrEqual(8);

      // Linked records nearer the turn than the question it answers still leave it room.
      const { queryDocuments } = await import('../store/index.js');
      const task2 = await createTask('Tune the export retries', {}, C);
      const turn2 = 'The export retry backoff on shard 7 doubles each attempt up to 30 seconds, and the export region is us-east-2.';
      for (let i = 0; i < 9; i++) {
        await storeMemory(`The export retry backoff on shard 7 doubles each attempt up to 30 seconds (note ${i}).`, {
          collection: C, typed: { kind: 'finding', task_ids: [task2] },
        });
      }
      const { ids: [region] } = await storeMemory('Which region does the export run in?', { collection: C, typed: { kind: 'question' } });
      const near = await queryDocuments(C, turn2, 40, { type: 'memory' });
      const qd = near.find(n => n.id === region)!.distance;
      const linkedNear = near.filter(n => String(n.metadata.task_ids ?? '').includes(task2));
      expect(linkedNear.length).toBe(9);
      expect(linkedNear.every(n => n.distance < qd)).toBe(true);
      expect(qd).toBeLessThan(0.75);
      expect((await findOpenItems(C, turn2, [task2])).map(i => i.id)).toContain(region);

      // Every open wait is judged while there is room, not only the first four.
      const task3 = await createTask('Plan the launch', {}, C);
      const decisions: string[] = [];
      for (const topic of ['the venue', 'the date', 'the budget', 'the speakers', 'the catering', 'the swag']) {
        decisions.push((await storeMemory(`Which option for ${topic}?`, {
          collection: C, typed: { kind: 'decision', status: 'needed', owner: 'josh', options: ['a', 'b'] },
        })).ids[0]);
      }
      await updateTask(task3, { waits_on: decisions } as any);
      const waits = await findOpenItems(C, 'yes, go with b', [task3]);
      expect(decisions.every(d => waits.some(i => i.id === d))).toBe(true);
    } finally {
      resetStore();
      resetConfig();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
