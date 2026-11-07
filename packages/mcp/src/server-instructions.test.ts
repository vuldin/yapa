import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_INSTRUCTIONS } from './rules.js';

describe('the MCP server', () => {
  it('sends the standing rules as its instructions in the initialize result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yapa-instructions-'));
    try {
      const child = spawn(process.execPath, [join(__dirname, '..', 'dist', 'index.js')], {
        env: {
          ...process.env, YAPA_STORAGE: 'local', YAPA_LOCAL_STORE_PATH: join(dir, 'store'), YAPA_SCOPE_FILE: join(dir, 'scope.json'),
          YAPA_SYNC_ENABLED: 'false', YAPA_UPDATE_CHECK: 'false', YAPA_SYNC_HEALTH_FILE: 'off',
        },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const reply = new Promise<any>((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', d => {
          buf += d;
          const nl = buf.indexOf('\n');
          if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
        });
        child.on('error', reject);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n');
      const r = await reply;
      child.kill();
      expect(r.result.instructions).toBe(SERVER_INSTRUCTIONS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
