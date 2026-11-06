import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfig, resetConfig, setConfig } from '../config.js';
import { mergeReportLines, type MergeResult } from '../collections/manage.js';
import {
  describeDataRules, parseDataRules, REFERENCE_DATA_RULES, remoteDataRules, setSyncBackend, type DataRules, type SyncBackend,
} from './backend.js';

describe('parseDataRules', () => {
  it('reads what a remote declares and falls back to the reference for anything absent or invalid', () => {
    expect(parseDataRules(undefined)).toEqual(REFERENCE_DATA_RULES);
    expect(parseDataRules({ deleted_retention_days: null, erasure: 'redact' })).toEqual({ deletedRetentionDays: null, erasure: 'redact' });
    expect(parseDataRules({ deleted_retention_days: 7, erasure: 'none' })).toEqual({ deletedRetentionDays: 7, erasure: 'none' });
    expect(parseDataRules({ deleted_retention_days: 0, erasure: 'shred' })).toEqual(REFERENCE_DATA_RULES);
    expect(parseDataRules({ deleted_retention_days: '30' })).toEqual(REFERENCE_DATA_RULES);
  });

  it('describes each rule in plain words', () => {
    expect(describeDataRules(REFERENCE_DATA_RULES)).toBe('deleted documents restorable 30 days; retracted or purged content removed');
    expect(describeDataRules({ deletedRetentionDays: null, erasure: 'none' })).toMatch(/until purged; .*kept on the remote, hidden/);
  });
});

describe('remoteDataRules', () => {
  let asked = 0;
  const rules: DataRules = { deletedRetentionDays: null, erasure: 'none' };
  let cached: DataRules | undefined;

  beforeAll(() => {
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'https://sync.example.test' }));
    setSyncBackend({
      kind: 'service', target: 'stub',
      dataRules: async () => { asked++; cached = rules; return rules; },
      cachedDataRules: () => cached,
    } as unknown as SyncBackend);
  });
  afterAll(() => {
    setSyncBackend(undefined);
    resetConfig();
  });

  it('asks the remote, and a cached-only lookup never does', async () => {
    expect(await remoteDataRules({ cachedOnly: true })).toBeUndefined();
    expect(asked).toBe(0);
    expect(await remoteDataRules()).toEqual(rules);
    expect(await remoteDataRules({ cachedOnly: true })).toEqual(rules);
    expect(asked).toBe(1);
  });
});

describe('a merge into a private collection on a remote that cannot erase', () => {
  const base: MergeResult = {
    from: 'project-acme', into: 'private-acme', moved: 3, byType: { memory: 3 }, dryRun: false, sourceRemoved: true, teammateRowsKept: 0, ownRowsRetracted: 3,
  };

  it('says the remote keeps the content', () => {
    expect(mergeReportLines({ ...base, remoteKeepsContent: true }).join('\n')).toMatch(/cannot erase: it keeps their content, hidden/);
    expect(mergeReportLines({ ...base, dryRun: true, remoteKeepsContent: true }).join('\n')).toMatch(/cannot erase/);
    expect(mergeReportLines(base).join('\n')).not.toMatch(/cannot erase/);
  });
});
