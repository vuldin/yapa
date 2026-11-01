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
});
