import { describe, it, expect, vi } from 'vitest';

const { scheduleSyncSoon } = vi.hoisted(() => ({ scheduleSyncSoon: vi.fn() }));
vi.mock('@yapa/core', async importOriginal => ({ ...(await importOriginal<any>()), scheduleSyncSoon }));

import { withSyncOnWrite, SYNC_ON_WRITE_TOOLS } from './tools.js';

function fakeServer() {
  const handlers = new Map<string, (...a: any[]) => any>();
  const server: any = { tool: (name: string, ...rest: any[]) => { handlers.set(name, rest[rest.length - 1]); } };
  return { server, handlers };
}

describe('withSyncOnWrite', () => {
  it('schedules a sync after write tools resolve, not for reads', async () => {
    const { server, handlers } = fakeServer();
    withSyncOnWrite(server);
    server.tool('memory_store', 'desc', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    server.tool('memory_recall', 'desc', {}, async () => ({ content: [] }));

    const result = await handlers.get('memory_store')!({});
    expect(result.content[0].text).toBe('ok');
    expect(scheduleSyncSoon).toHaveBeenCalledTimes(1);

    await handlers.get('memory_recall')!({});
    expect(scheduleSyncSoon).toHaveBeenCalledTimes(1);
  });

  it('covers every tool that mutates syncable state', () => {
    for (const name of ['memory_store', 'memory_forget', 'task_create', 'task_update', 'task_complete', 'task_delete', 'journal_consolidate', 'compaction_apply']) {
      expect(SYNC_ON_WRITE_TOOLS.has(name)).toBe(true);
    }
  });
});
