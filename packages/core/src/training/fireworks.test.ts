import { describe, expect, it, vi } from 'vitest';
import { FireworksBackend, type FirectlRunner } from './fireworks.js';

function makeRunner(map: Record<string, { stdout?: string; stderr?: string; code?: number }>): FirectlRunner {
  return {
    async run(args: string[]) {
      const key = args.join(' ');
      const entry = Object.entries(map).find(([pattern]) => key.includes(pattern));
      if (!entry) throw new Error(`No mock for: ${key}`);
      const { stdout = '', stderr = '', code = 0 } = entry[1];
      return { stdout, stderr, code };
    },
  };
}

describe('FireworksBackend.submit', () => {
  it('creates dataset then sft job and extracts job id from JSON output', async () => {
    const runner = makeRunner({
      'create dataset': { stdout: '{"id":"ds-1"}' },
      'sftj create': { stdout: '{"id":"sftj_abc123","state":"pending"}' },
    });
    const spy = vi.spyOn(runner, 'run');
    const backend = new FireworksBackend(runner);
    const handle = await backend.submit({
      datasetPath: '/tmp/fake.jsonl',
      baseModel: 'accounts/fireworks/models/qwen3-coder-30b-a3b-instruct',
      outputModelId: 'yapa-adapter-test',
    });
    expect(handle.backend).toBe('fireworks');
    expect(handle.jobId).toBe('sftj_abc123');
    // Both firectl calls happened
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('tolerates "already exists" on dataset create', async () => {
    const runner = makeRunner({
      'create dataset': { stderr: 'dataset already exists\n', code: 1 },
      'sftj create': { stdout: '{"id":"sftj_xyz","state":"pending"}' },
    });
    const backend = new FireworksBackend(runner);
    const handle = await backend.submit({
      datasetPath: '/tmp/x.jsonl',
      baseModel: 'b',
      outputModelId: 'id',
    });
    expect(handle.jobId).toBe('sftj_xyz');
  });

  it('throws when sft create fails', async () => {
    const runner = makeRunner({
      'create dataset': { stdout: '{"id":"ds"}' },
      'sftj create': { stderr: 'quota exceeded', code: 1 },
    });
    const backend = new FireworksBackend(runner);
    await expect(backend.submit({
      datasetPath: '/tmp/x.jsonl',
      baseModel: 'b',
      outputModelId: 'id',
    })).rejects.toThrow(/quota exceeded/);
  });

  it('falls back to regex extraction when JSON is not structured', async () => {
    const runner = makeRunner({
      'create dataset': { stdout: '' },
      'sftj create': { stdout: 'Created job. ID: sftj_fallback_99\n' },
    });
    const backend = new FireworksBackend(runner);
    const handle = await backend.submit({
      datasetPath: '/tmp/x.jsonl',
      baseModel: 'b',
      outputModelId: 'id',
    });
    expect(handle.jobId).toBe('sftj_fallback_99');
  });
});

describe('FireworksBackend.poll', () => {
  it('maps Fireworks state strings to the common TrainingJobState', async () => {
    const runner = makeRunner({
      'sftj get': { stdout: '{"state":"COMPLETED","output_model":"accounts/acct/models/yapa-adapter-test"}' },
    });
    const backend = new FireworksBackend(runner);
    const status = await backend.poll({ backend: 'fireworks', jobId: 'j-1' });
    expect(status.state).toBe('completed');
    expect(status.outputModelRef).toBe('accounts/acct/models/yapa-adapter-test');
  });

  it('reports failed state', async () => {
    const runner = makeRunner({
      'sftj get': { stdout: '{"state":"failed","error":"OOM"}' },
    });
    const backend = new FireworksBackend(runner);
    const status = await backend.poll({ backend: 'fireworks', jobId: 'j-1' });
    expect(status.state).toBe('failed');
    expect(status.error).toBe('OOM');
  });

  it('reports unknown state gracefully when firectl errors', async () => {
    const runner = makeRunner({
      'sftj get': { stderr: 'permission denied', code: 2 },
    });
    const backend = new FireworksBackend(runner);
    const status = await backend.poll({ backend: 'fireworks', jobId: 'j-1' });
    expect(status.state).toBe('unknown');
    expect(status.error).toBe('permission denied');
  });
});

describe('FireworksBackend.cancel', () => {
  it('runs the cancel command', async () => {
    const runner = makeRunner({
      'sftj cancel': { stdout: 'cancelled' },
    });
    const spy = vi.spyOn(runner, 'run');
    const backend = new FireworksBackend(runner);
    await backend.cancel({ backend: 'fireworks', jobId: 'j-1' });
    expect(spy).toHaveBeenCalledWith(['sftj', 'cancel', 'j-1']);
  });
});

describe('FireworksBackend.retrieve', () => {
  it('returns the adapter artifact when the job is complete', async () => {
    const runner = makeRunner({
      'sftj get': { stdout: '{"state":"completed","output_model":"accounts/x/models/y"}' },
    });
    const backend = new FireworksBackend(runner);
    const artifact = await backend.retrieve({ backend: 'fireworks', jobId: 'j-1' });
    expect(artifact.ref).toBe('accounts/x/models/y');
  });

  it('throws when the job is not yet completed', async () => {
    const runner = makeRunner({
      'sftj get': { stdout: '{"state":"running"}' },
    });
    const backend = new FireworksBackend(runner);
    await expect(backend.retrieve({ backend: 'fireworks', jobId: 'j-1' })).rejects.toThrow(/state running/);
  });
});
