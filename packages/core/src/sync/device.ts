import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from '../config.js';

let cached: { path: string; id: string } | undefined;

/**
 * Stable id for this machine's YAPA install, stamped on every pushed row as
 * `metadata.origin_device`. Pull skips rows last written by THIS device, so a
 * user's other machines (same username, different device) still sync.
 *
 * Resolution: `YAPA_DEVICE_ID` if set, else a UUID persisted at DEVICE_ID_PATH
 * on first use. The file is shared by the MCP server and the hook processes on
 * one machine, so both stamp and filter with the same id.
 */
export function getDeviceId(): string {
  const config = getConfig();
  if (config.DEVICE_ID) return config.DEVICE_ID;
  if (cached?.path === config.DEVICE_ID_PATH) return cached.id;

  const path = config.DEVICE_ID_PATH;
  let id: string;
  try {
    id = readFileSync(path, 'utf-8').trim();
  } catch {
    id = '';
  }
  if (!id) {
    id = randomUUID();
    try {
      mkdirSync(dirname(path), { recursive: true });
      // 'wx': if a sibling process created it first, adopt theirs.
      writeFileSync(path, `${id}\n`, { flag: 'wx' });
    } catch {
      try {
        id = readFileSync(path, 'utf-8').trim() || id;
      } catch {
        // Unwritable location: fall back to a per-process id (still correct,
        // just re-pulls this device's own rows as no-op skips).
      }
    }
  }
  cached = { path, id };
  return id;
}

/** Test hook: forget the memoized id. */
export function resetDeviceId(): void {
  cached = undefined;
}
