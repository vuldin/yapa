/**
 * The whole loop, over a real (local) store, with the auxiliary LLM scripted:
 * typed memories are created and kept current by the normal flow between a
 * person, an agent and the work, with nobody calling a memory tool by hand.
 *
 *   1. An agent works a task; capture after its turn stores a finding, typed
 *      and linked to the task the session holds.
 *   2. The agent hits a choice only a person can make: the task waits on a
 *      needed decision and leaves the ready queue; the owner sees it waiting.
 *   3. Someone else's turn cannot settle it (only the owner decides).
 *   4. The owner answers in chat; follow-through records the choice, and the
 *      task is ready again by itself.
 *   5. Later turns resolve the finding and answer an open question; moves the
 *      rules don't allow are dropped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig, getConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds, getDocumentsByFilter } from '../store/index.js';
import { setHostLLMCaller, type LLMRequestOptions } from './provider.js';
import { captureTurn } from './capture.js';
import { createTask } from '../tasks/create.js';
import { getTask } from '../tasks/update.js';
import { requestDecision } from '../tasks/close.js';
import { nextTasks } from '../tasks/next.js';
import { waitingOn } from '../tasks/waiting.js';
import { storeMemory } from '../memory/store.js';

const C = 'project-loop';
let dir: string;

/** Scripted aux LLM: answers by which prompt is asking. */
let extractorReply = '[]';
let followReply = '[]';
const seen: Array<{ system: string; user: string }> = [];
async function scripted(o: LLMRequestOptions): Promise<string> {
  const system = String(o.messages[0]?.content ?? '');
  const user = String(o.messages[1]?.content ?? '');
  seen.push({ system, user });
  if (system.includes('memory extractor')) return extractorReply;
  if (system.includes('open items current')) return followReply;
  return JSON.stringify({ action: 'add', rationale: 'distinct' });
}

const as = (user: string) => setConfig(createConfig({ YAPA_USERNAME: user, YAPA_SYNC_ENABLED: 'true', YAPA_COMPACTION_THRESHOLD: '100000' }));
const opts = (taskIds: string[] = []) => ({ maxMemories: 3, maxSalience: 2, dedupeDistance: 0.05, taskIds });
const turn = (userText: string, assistantText: string) => ({ collection: C, sessionId: 's', turn: 1, userText, assistantText });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-loop-test-'));
  as('alex');
  setStore(createLocalStore(dir));
  setHostLLMCaller(scripted);
});

afterAll(async () => {
  setHostLLMCaller(undefined);
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('typed memories are created and kept current by the work itself', () => {
  let task: string;
  let finding: string;
  let decision: string;

  it('1. capture after an agent turn stores a typed finding linked to the held task', async () => {
    task = await createTask('Pick the queue for order events', { tags: ['auto'] }, C);
    extractorReply = JSON.stringify([{
      content: 'Under load the current queue drops messages once its in-memory buffer passes 10k entries.',
      tags: ['queue'], sector: 'semantic', salience: 2, rationale: 'root cause', kind: 'finding',
    }]);
    const r = await captureTurn(turn('why are we losing events?', 'Found it: the buffer overflows past 10k entries and drops messages.'), opts([task]));
    expect(r.stored).toBe(1);
    const [m] = await getDocumentsByFilter(C, { type: 'memory', kind: 'finding' });
    finding = m.id;
    expect(m.metadata).toMatchObject({ kind: 'finding', status: 'open', task_ids: [task], source: 'auto-capture' });
    expect((await getTask(task))?.metadata.memory_ids).toEqual([finding]);
  });

  it('2. a choice only a person can make: the task waits and the owner sees it', async () => {
    const r = await requestDecision(task, {
      question: 'Move order events to the durable log, or raise the buffer and keep the queue?',
      options: ['the durable log', 'a bigger buffer'], recommendation: 'the durable log', owner: 'josh',
    });
    decision = r.decision;
    expect((await getTask(task))?.metadata).toMatchObject({ status: 'pending', waits_on: [decision] });
    const next = await nextTasks({ collection: C, autoOnly: true });
    expect(next.ready).toEqual([]);
    expect(next.skipped.find(s => s.id === task)?.reason).toMatch(/^waiting on decision/);
    const w = await waitingOn({ user: 'josh' });
    expect(w.decisions.map(d => [d.id, d.waiting_tasks])).toEqual([[decision, [task]]]);
  });

  it('3. a turn by someone other than the owner does not settle the decision', async () => {
    as('alex');
    extractorReply = '[]';
    followReply = JSON.stringify([{ id: decision, status: 'accepted', note: 'the durable log', evidence: 'just use the durable log' }]);
    const r = await captureTurn(turn('just use the durable log', 'OK.'), opts([task]));
    expect(r.settled).toBeUndefined();
    const [d] = await getDocumentsByIds(C, [decision]);
    expect(d.metadata.status).toBe('needed');
  });

  it('4. the owner answers in chat: the choice is recorded and the task is ready again', async () => {
    as('josh');
    seen.length = 0;
    followReply = JSON.stringify([{ id: decision, status: 'accepted', note: 'the durable log; keep the queue for retries only', evidence: 'Go with the durable log.' }]);
    const r = await captureTurn(turn('Go with the durable log. Keep the queue only for retries.', 'Noted.'), opts());
    expect(r.settled).toEqual([{ id: decision, kind: 'decision', status: 'accepted', note: 'the durable log; keep the queue for retries only' }]);
    expect(r.notice).toContain(`decision ${decision} accepted`);
    // The judge was shown the open decision (found by meaning, not by task).
    expect(seen.find(s => s.system.includes('open items current'))?.user).toContain(`id: ${decision}`);

    const [d] = await getDocumentsByIds(C, [decision]);
    expect(d.metadata.status).toBe('accepted');
    expect(d.content).toMatch(/josh: the durable log; keep the queue for retries only$/);
    expect((await waitingOn({ user: 'josh' })).decisions).toEqual([]);

    as('alex');
    const next = await nextTasks({ collection: C, autoOnly: true });
    expect(next.ready.map(t => t.id)).toEqual([task]);
  });

  it('5. later turns resolve the finding and answer a question; disallowed moves are dropped', async () => {
    as('alex');
    const { ids: [question] } = await storeMemory('Does the durable log keep order per customer, or only per partition?', {
      collection: C, typed: { kind: 'question', owner: 'platform-team' },
    });
    followReply = JSON.stringify([
      { id: finding, status: 'resolved', evidence: 'order is per partition' },  // no disposition: invalid, dropped
      { id: question, status: 'answered', note: 'per partition; key by customer id', evidence: 'order is per partition, so we key by customer id' },
      { id: 'mem-not-shown', status: 'answered', note: 'x', evidence: 'order is per partition' }, // never shown: dropped
    ]);
    let r = await captureTurn(turn('', 'The platform team confirmed: order is per partition, so we key by customer id.'), opts([task]));
    expect(r.settled?.map(s => [s.id, s.status])).toEqual([[question, 'answered']]);
    expect((await getDocumentsByIds(C, [finding]))[0].metadata.status).toBe('open');

    followReply = JSON.stringify([{ id: finding, status: 'resolved', disposition: 'decision', disposition_ids: [decision], note: 'addressed by the move to the log', evidence: 'order events move to the durable log' }]);
    r = await captureTurn(turn('', `The overflow is addressed by ${decision}: order events move to the durable log.`), opts([task]));
    expect(r.settled?.map(s => s.id)).toEqual([finding]);
    expect((await getDocumentsByIds(C, [finding]))[0].metadata).toMatchObject({ status: 'resolved', disposition: 'decision', disposition_ids: [decision] });
    expect(getConfig().USERNAME).toBe('alex');
  });
});
