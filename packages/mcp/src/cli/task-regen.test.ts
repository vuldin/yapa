import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The completion is written, then its next occurrence fails.
const { pushDocsNow } = vi.hoisted(() => ({ pushDocsNow: vi.fn(async () => ({ errors: 0 })) }));
vi.mock('@yapa/core', async importOriginal => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    pushDocsNow,
    completeTask: vi.fn(async (id: string) => {
      await actual.updateTask(id, { status: 'complete' });
      throw new actual.RegenerationError(id, new Error('store unavailable'));
    }),
  };
});

import { setConfig, createConfig, resetConfig, setStore, resetStore, createLocalStore, createTask, getTask } from '@yapa/core';
import { runTask } from './task.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-task-cli-regen-'));
  setConfig(createConfig({ YAPA_USERNAME: 'josh', YAPA_SYNC_ENABLED: 'false', YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases') }));
  setStore(createLocalStore(join(dir, 'store')));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('yapa task release --status complete when the next occurrence fails', () => {
  it('still pushes the completion, exits 5 and says to retry', async () => {
    const id = await createTask('sweep the chimney', { recurrence_pattern: 'yearly' }, 'project-cli-regen');
    const r = await runTask('release', [id, '--status', 'complete']);
    expect(r.exit).toBe(5);
    expect(r.json).toMatchObject({ ok: true, id, status: 'complete', regenerated: null });
    expect(r.json.regeneration_error).toMatch(/complete it again to retry/);
    expect(r.text).toMatch(new RegExp(`^${id} -> complete; ${id} is complete, but its next occurrence could not be created`));
    expect(pushDocsNow).toHaveBeenCalledWith('project-cli-regen', [id]);
    expect((await getTask(id))?.metadata.status).toBe('complete');
  });
});
