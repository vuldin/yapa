import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { getDeviceId, resetDeviceId } from './device.js';

afterEach(() => {
  resetDeviceId();
  resetConfig();
});

describe('getDeviceId', () => {
  it('honors YAPA_DEVICE_ID', () => {
    setConfig(createConfig({ YAPA_DEVICE_ID: 'laptop-1' }));
    expect(getDeviceId()).toBe('laptop-1');
  });

  it('persists a generated id so hooks and the MCP server agree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yapa-device-'));
    try {
      const path = join(dir, 'nested', 'device-id');
      setConfig(createConfig({ YAPA_DEVICE_ID_PATH: path }));
      const first = getDeviceId();
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect(readFileSync(path, 'utf-8').trim()).toBe(first);

      resetDeviceId(); // a second process reading the same file
      expect(getDeviceId()).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
