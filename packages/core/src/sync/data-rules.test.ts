import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfig, resetConfig, setConfig } from '../config.js';
import { mergeReportLines, type MergeResult } from '../collections/manage.js';
import {
  describeDataRules, parseDataRules, REFERENCE_DATA_RULES, remoteDataRules, setSyncBackend, type DataRules, type SyncBackend,
} from './backend.js';

describe('parseDataRules', () => {
  it('reads what a remote declares and falls back to the reference for anything absent', () => {
    expect(parseDataRules(undefined)).toEqual(REFERENCE_DATA_RULES);
    expect(parseDataRules({ deleted_retention_days: null, erasure: 'redact' })).toEqual({ deletedRetentionDays: null, erasure: 'redact' });
    expect(parseDataRules({ deleted_retention_days: 7, erasure: 'none' })).toEqual({ deletedRetentionDays: 7, erasure: 'none' });
    expect(parseDataRules({ similarity_threshold: 0.95 })).toEqual(REFERENCE_DATA_RULES);
  });

  it('never reads a declared value it does not know as the reassuring answer', () => {
    expect(parseDataRules({ erasure: 'deferred' })).toEqual({ deletedRetentionDays: 30, erasure: 'none', unrecognized: ['erasure="deferred"'] });
    expect(parseDataRules({ deleted_retention_days: 0 })).toEqual({ deletedRetentionDays: undefined, erasure: 'delete', unrecognized: ['deleted_retention_days=0'] });
    expect(parseDataRules({ deleted_retention_days: '30' }).deletedRetentionDays).toBeUndefined();
    expect(describeDataRules(parseDataRules({ erasure: 'deferred', deleted_retention_days: '30' })))
      .toBe('deleted documents restorable for an unknown time; the remote declares rules this client does not know (deleted_retention_days="30", erasure="deferred"), so retracted or purged content may stay on it');
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
    expect(mergeReportLines(base).join('\n')).not.toMatch(/cannot erase|aren't known/);
    expect(mergeReportLines({ ...base, remoteRulesUnknown: true }).join('\n')).toMatch(/data rules aren't known yet \(see `sync status`\)/);
  });
});
