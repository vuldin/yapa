/**
 * TrainingBackend abstraction. First implementation is Fireworks via firectl;
 * local (Unsloth) is a later phase that plugs in here without changing callers.
 */

export interface TrainingJobConfig {
  /** Path to the final chat-format JSONL that will be uploaded to the backend. */
  datasetPath: string;
  /** Path to an optional held-out eval dataset. */
  evaluationDatasetPath?: string;
  /** Fully-qualified base-model identifier understood by the backend. */
  baseModel: string;
  /** A stable, user-visible identifier for the resulting adapter (backend may adapt it). */
  outputModelId: string;
  /** Optional backend-specific hyperparameters. */
  hyperparameters?: Record<string, any>;
}

export interface TrainingJobHandle {
  backend: string;
  jobId: string;
  /** Fully-qualified identifier of the output model/adapter once training completes. */
  outputModelRef?: string;
  /** Raw backend response for debugging. */
  raw?: unknown;
}

export type TrainingJobState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface TrainingJobStatus {
  state: TrainingJobState;
  progress?: number;
  error?: string;
  outputModelRef?: string;
  raw?: unknown;
}

export interface AdapterArtifact {
  /** Backend-specific reference. Fireworks: `accounts/<acct>/models/<id>`. Local: filesystem path. */
  ref: string;
  metadata: Record<string, any>;
}

export interface TrainingBackend {
  readonly name: string;
  submit(config: TrainingJobConfig): Promise<TrainingJobHandle>;
  poll(handle: TrainingJobHandle): Promise<TrainingJobStatus>;
  retrieve(handle: TrainingJobHandle): Promise<AdapterArtifact>;
  cancel(handle: TrainingJobHandle): Promise<void>;
}
