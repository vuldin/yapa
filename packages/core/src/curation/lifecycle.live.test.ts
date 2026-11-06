/**
 * The capture prompts against a real model (opt-in): do the extractor and
 * follow-through actually type what they store and settle what a person
 * decides, and leave alone what nobody decided?
 *
 *   YAPA_LIVE_LLM=1 npx vitest run src/curation/lifecycle.live.test.ts   (in packages/core)
 *
 * Uses the configured curation provider (YAPA_CURATION_LLM_PROVIDER; with
 * claude-cli it runs `claude -p` on the subscription). Skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds } from '../store/index.js';
import { extractMemories } from './extractor.js';
import { followThrough } from './follow-through.js';
import { storeMemory } from '../memory/store.js';

const LIVE = process.env.YAPA_LIVE_LLM === '1';
const C = 'project-live';
let dir: string;

describe.skipIf(!LIVE)('capture prompts against a real model (opt-in)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yapa-live-llm-'));
    setConfig(createConfig({
      YAPA_USERNAME: 'josh',
      YAPA_CURATION_LLM_PROVIDER: process.env.YAPA_CURATION_LLM_PROVIDER ?? 'claude-cli',
      YAPA_CURATION_MODEL: process.env.YAPA_CURATION_MODEL ?? 'haiku',
    }));
    setStore(createLocalStore(dir));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    resetStore();
    resetConfig();
  });

  it('the extractor types a root cause as a finding and an open question as a question', async () => {
    const got = await extractMemories({
      collection: C,
      userText: 'Why did the nightly export fail again?',
      assistantText: 'Root cause: the export job runs as the reporting user, whose database password expired on Monday, so every run since fails at login with "password authentication failed". '
        + 'Rotating it fixes tonight. Separately, we need the platform team to tell us whether service accounts can be exempted from password expiry; I could not find that documented.',
    });
    const kinds = got.map(g => g.kind);
    expect(kinds).toContain('finding');
    expect(kinds.some(k => k === 'question')).toBe(true);
    expect(got.every(g => g.kind !== 'decision')).toBe(true); // nothing was decided
  }, 120_000);

  it('follow-through records the person\'s choice, and nothing when the turn only discusses it', async () => {
    const { ids: [decision] } = await storeMemory('Should the nightly export run as a dedicated service account, or keep the reporting user and rotate its password monthly?', {
      collection: C,
      typed: { kind: 'decision', status: 'needed', owner: 'josh', options: ['a dedicated service account', 'keep the reporting user, rotate monthly'], recommendation: 'a dedicated service account' },
    });

    const talk = await followThrough({
      collection: C,
      userText: 'Hmm, what are the trade-offs of a service account for the nightly export? Let me think about it.',
      assistantText: 'A service account needs a ticket to the platform team but removes the expiry problem; rotating monthly is quicker but someone has to remember.',
    });
    expect(talk.changes).toEqual([]);

    const chose = await followThrough({
      collection: C,
      userText: 'OK, go with the dedicated service account for the nightly export. File the ticket.',
      assistantText: 'Will do: I will file the platform ticket for a service account for the export.',
    });
    expect(chose.changes.map(c => [c.id, c.status])).toEqual([[decision, 'accepted']]);
    const [d] = await getDocumentsByIds(C, [decision]);
    expect(d.metadata.status).toBe('accepted');
  }, 180_000);

  it('follow-through answers a question the turn settles, and leaves an unrelated finding open', async () => {
    const L = 'project-live-2';
    const { ids: [question] } = await storeMemory('Will the remote allow a narrow exception so the sync role can blank the content of revisions of its own retracted records?', {
      collection: L, typed: { kind: 'question' },
    });
    const { ids: [finding] } = await storeMemory('The client\'s purge() treats the purged_copies status as an internal error instead of a success.', {
      collection: L, typed: { kind: 'finding' },
    });

    const unrelated = await followThrough({
      collection: L,
      userText: 'merged 75, now 74 has conflicts',
      assistantText: 'Resolved #74\'s conflicts with main after #75 merged: the CHANGELOG and backend.ts kept both sides, the HTTP backend tests moved into the shared suites file, and the bundles were rebuilt. Pushed.',
    });
    expect(unrelated.changes).toEqual([]);

    const answered = await followThrough({
      collection: L,
      userText: 'go with this approach, the remote owner agreed to the exception',
      assistantText: 'OK. The remote erases by redaction: a retract or purge blanks every revision\'s title, body and metadata, and a trigger allows only that UPDATE, only for the sync role on its own retracted records.',
    });
    expect(answered.changes.map(c => [c.id, c.status])).toEqual([[question, 'answered']]);
    expect((await getDocumentsByIds(L, [finding]))[0].metadata.status).toBe('open');
  }, 180_000);

  it('a question for someone outside YAPA is answered by their reported answer, not by the person\'s own plan', async () => {
    const L = 'project-live-3';
    const { ids: [question] } = await storeMemory('Can service accounts be exempted from password expiry?', {
      collection: L, typed: { kind: 'question', owner: 'the platform team' },
    });
    const plan = await followThrough({
      collection: L,
      userText: 'Let\'s plan on a service account for the export, I\'ll ask the platform team about expiry.',
      assistantText: 'OK: the export moves to a service account once the platform team says whether it can skip password expiry.',
    });
    expect(plan.changes).toEqual([]);
    const reply = await followThrough({
      collection: L,
      userText: 'the platform team got back to me',
      assistantText: 'The platform team confirmed service accounts can be exempted from password expiry if they are tagged svc- and owned by a team.',
    });
    expect(reply.changes.map(c => [c.id, c.status])).toEqual([[question, 'answered']]);
  }, 180_000);
});
