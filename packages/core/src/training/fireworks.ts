import { getConfig } from '../config.js';
import { spawn } from 'child_process';

import type {
  AdapterArtifact,
  TrainingBackend,
  TrainingJobConfig,
  TrainingJobHandle,
  TrainingJobState,
  TrainingJobStatus,
} from './backend.js';

interface FirectlResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface FirectlRunner {
  run(args: string[]): Promise<FirectlResult>;
}

const defaultRunner: FirectlRunner = {
  async run(args) {
    return new Promise<FirectlResult>((resolve, reject) => {
      const child = spawn(getConfig().TRAINING_FIRECTL_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', err => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(
            `firectl not found at "${getConfig().TRAINING_FIRECTL_PATH}". Install it from https://docs.fireworks.ai/tools-sdks/firectl or set YAPA_TRAINING_FIRECTL_PATH to its location.`,
          ));
        } else {
          reject(err);
        }
      });
      child.on('close', code => {
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
  },
};

/** Best-effort JSON parser that tolerates firectl printing extra lines. */
function tryJsonParse(raw: string): any {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    try { return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)); } catch { /* fall through */ }
  }
  return null;
}

function mapState(raw: unknown): TrainingJobState {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('complete') || s === 'succeeded' || s === 'success') return 'completed';
  if (s.includes('fail') || s === 'error') return 'failed';
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('run') || s === 'in_progress') return 'running';
  if (s === 'pending' || s === 'queued' || s === 'created') return 'pending';
  return 'unknown';
}

export class FireworksBackend implements TrainingBackend {
  readonly name = 'fireworks';

  constructor(private runner: FirectlRunner = defaultRunner) {}

  async submit(config: TrainingJobConfig): Promise<TrainingJobHandle> {
    // Step 1: register the dataset
    const datasetId = config.outputModelId.replace(/[^a-z0-9-]/gi, '-').toLowerCase() + '-data';
    const dsArgs = ['create', 'dataset', datasetId, config.datasetPath];
    const dsResult = await this.runner.run(dsArgs);
    if (dsResult.code !== 0 && !/already exists/i.test(dsResult.stderr)) {
      throw new Error(`firectl dataset create failed: ${dsResult.stderr || dsResult.stdout}`);
    }

    // Step 2: create the SFT job
    const jobArgs = [
      'sftj', 'create',
      '--base-model', config.baseModel,
      '--dataset', datasetId,
      '--output-model', config.outputModelId,
    ];
    if (config.evaluationDatasetPath) {
      jobArgs.push('--evaluation-dataset', config.evaluationDatasetPath);
    }
    const hp = config.hyperparameters ?? {};
    if (typeof hp.epochs === 'number') jobArgs.push('--epochs', String(hp.epochs));
    if (typeof hp.learningRate === 'number') jobArgs.push('--learning-rate', String(hp.learningRate));
    if (typeof hp.loraRank === 'number') jobArgs.push('--lora-rank', String(hp.loraRank));
    if (hp.earlyStop === true) jobArgs.push('--early-stop');

    const jobResult = await this.runner.run(jobArgs);
    if (jobResult.code !== 0) {
      throw new Error(`firectl sftj create failed: ${jobResult.stderr || jobResult.stdout}`);
    }

    const parsed = tryJsonParse(jobResult.stdout);
    const jobId = parsed?.id ?? parsed?.name ?? extractJobIdFromText(jobResult.stdout);
    if (!jobId) {
      throw new Error(`Could not determine job ID from firectl output:\n${jobResult.stdout}`);
    }

    return {
      backend: this.name,
      jobId: String(jobId),
      raw: parsed ?? jobResult.stdout,
    };
  }

  async poll(handle: TrainingJobHandle): Promise<TrainingJobStatus> {
    const result = await this.runner.run(['sftj', 'get', handle.jobId]);
    if (result.code !== 0) {
      return {
        state: 'unknown',
        error: result.stderr || result.stdout,
      };
    }
    const parsed = tryJsonParse(result.stdout);
    const state = mapState(parsed?.state ?? parsed?.status);
    return {
      state,
      outputModelRef: parsed?.outputModel ?? parsed?.output_model ?? parsed?.output_model_ref,
      error: state === 'failed' ? (parsed?.error ?? 'failed') : undefined,
      raw: parsed ?? result.stdout,
    };
  }

  async retrieve(handle: TrainingJobHandle): Promise<AdapterArtifact> {
    const status = await this.poll(handle);
    if (status.state !== 'completed') {
      throw new Error(`Cannot retrieve — job ${handle.jobId} is in state ${status.state}`);
    }
    const ref = status.outputModelRef;
    if (!ref) throw new Error(`Completed job ${handle.jobId} had no outputModelRef`);
    return {
      ref,
      metadata: { raw: status.raw, backend: this.name },
    };
  }

  async cancel(handle: TrainingJobHandle): Promise<void> {
    const result = await this.runner.run(['sftj', 'cancel', handle.jobId]);
    if (result.code !== 0) {
      throw new Error(`firectl sftj cancel failed: ${result.stderr || result.stdout}`);
    }
  }
}

function extractJobIdFromText(stdout: string): string | null {
  // Fallback: match "Job ID: xxx" or "id: xxx" pattern
  const patterns = [
    /(?:job\s*id|id)\s*[:=]\s*([A-Za-z0-9_\-]+)/i,
    /sftj_[A-Za-z0-9]+/,
  ];
  for (const p of patterns) {
    const m = stdout.match(p);
    if (m) return m[1] ?? m[0];
  }
  return null;
}
