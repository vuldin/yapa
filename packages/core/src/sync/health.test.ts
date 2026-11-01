import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfig, setConfig, resetConfig } from '../config.js';
import { healthStatusFor, readSyncHealth, recordSyncHealth, recordUnpushed } from './health.js';
import { isSignedOutError, lastSyncError, noteSyncError, noteSyncOk } from './backend.js';
import { ServiceError } from './http-backend.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-health-'));
  file = join(dir, 'sub', 'sync-health.json');
  setConfig(createConfig({ YAPA_SYNC_HEALTH_FILE: file, YAPA_SYNC_INTERVAL_MS: '60000', YAPA_STATUS_LABEL: 'acme-sync' }));
});

afterEach(() => {
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('sync health record', () => {
  it('maps error codes to what the person sees', () => {
    expect(healthStatusFor('token_command')).toBe('signed_out');
    expect(healthStatusFor('unauthenticated')).toBe('signed_out');
    expect(healthStatusFor('cloud_run_unauthenticated')).toBe('signed_out');
    expect(healthStatusFor('unreachable')).toBe('unreachable');
    expect(healthStatusFor('rate_limited')).toBe('error');
    expect(healthStatusFor(undefined)).toBe('error');
  });

  it('keeps the start of a failure streak across observations, and clears it on success', () => {
    recordSyncHealth({ status: 'ok' }, 1000);
    const first = recordSyncHealth({ status: 'signed_out', code: 'token_command', message: 'no token' }, 2000)!;
    expect(first).toMatchObject({ status: 'signed_out', since: 2000, at: 2000, last_ok_at: 1000, label: 'acme-sync', interval_ms: 60000 });
    // A different failure later is still the same outage.
    recordSyncHealth({ status: 'unreachable', code: 'unreachable' }, 3000);
    expect(readSyncHealth()).toMatchObject({ status: 'unreachable', since: 2000, at: 3000 });
    const ok = recordSyncHealth({ status: 'ok' }, 4000)!;
    expect(ok).toEqual({ status: 'ok', at: 4000, last_ok_at: 4000, interval_ms: 60000, label: 'acme-sync' });
  });

  it('keeps the to-push count until a new one is known', () => {
    recordSyncHealth({ status: 'ok', unpushed: 3 }, 1000);
    recordSyncHealth({ status: 'signed_out' }, 2000);
    expect(readSyncHealth()?.unpushed).toBe(3);
    recordUnpushed(5);
    expect(readSyncHealth()).toMatchObject({ status: 'signed_out', since: 2000, unpushed: 5 });
  });

  it('writes 0600 atomically and reads a corrupt file as no record', () => {
    recordSyncHealth({ status: 'ok' }, 1000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'sub'))).toEqual(['sync-health.json']);
    writeFileSync(file, '{not json');
    expect(readSyncHealth()).toBeUndefined();
  });

  it('records nothing when the file is off', () => {
    setConfig(createConfig({ YAPA_SYNC_HEALTH_FILE: 'off' }));
    expect(recordSyncHealth({ status: 'ok' })).toBeUndefined();
    expect(readSyncHealth()).toBeUndefined();
  });
});

describe('noteSyncError / noteSyncOk', () => {
  it('record failures by code and clear the in-memory error on success', () => {
    noteSyncError(new ServiceError('could not get a Google ID token. Run `gcloud auth login`.', 0, 'token_command'));
    expect(readSyncHealth()).toMatchObject({ status: 'signed_out', code: 'token_command' });
    expect(lastSyncError()?.message).toContain('gcloud auth login');
    noteSyncOk(2);
    expect(readSyncHealth()).toMatchObject({ status: 'ok', unpushed: 2 });
    expect(lastSyncError()).toBeUndefined();
  });

  it('a plain error (no code) is a generic sync error', () => {
    noteSyncError(new Error('relation does not exist'));
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toMatchObject({ status: 'error', message: 'relation does not exist' });
  });

  it('isSignedOutError picks out sign-in failures only', () => {
    expect(isSignedOutError(new ServiceError('x', 401, 'unauthenticated'))).toBe(true);
    expect(isSignedOutError(new ServiceError('x', 503, 'unavailable'))).toBe(false);
  });
});
