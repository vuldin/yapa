/**
 * Advanced YAPA tool groups for the DeepSeek Harness: curation (LLM
 * classifier), bucket routing (system-prompt companion + training manifest),
 * training/eval/promotion, and remote sync.
 *
 * Auxiliary LLM calls route through the harness (`installLlmBridge`) unless
 * the legacy `YAPA_CURATION_*` provider config is in force.
 *
 * @module yapa-dsh/tools-advanced
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  chromaStore,
  getStore,
  adapterDemote,
  adapterPromote,
  bucketRouteNow,
  bucketRoutePreview,
  bucketStatus,
  checkRemoteHealth,
  classifyMemories,
  curationCycle,
  evalCompare,
  evalRun,
  getAdapter,
  getCurationState,
  getCurationModel,
  getConfig,
  getDocumentsByFilter,
  getOrCreateCollection,
  getPendingDeletes,
  getRemoteCollections,
  getSyncPullTimestamp,
  getSyncState,
  getSyncSubscriptions,
  listCollections,
  systemPromptActivate,
  systemPromptDeactivate,
  syncCycle,
  trainingCancel,
  trainingDatasetPreview,
  trainingGet,
  trainingStatus,
  trainingTrigger,
  updateAdapter,
  updateSyncSubscriptions,
  verifyAdapterAgainstManifest,
} from '@yapa/core';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

/** Bulky structured payloads keep an open schema; render() owns the text. */
const openObject = { type: 'object', additionalProperties: true } as const;
const openArray = { type: 'array', items: openObject } as const;

/** `confirm: true` gate shared by destructive/costly tools. */
const confirmParam = {
  type: 'boolean',
  const: true,
  description: 'Required safety flag — must be true',
} as const;

export function registerAdvancedTools(ctx: Context): void {
  // --- Curation -----------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_curation_now',
    description:
      'Trigger an immediate curation cycle: classifies unscored memories with '
      + 'trainable/durability/generalizability scores using the harness LLM route '
      + '(auxProvider/auxModel or the default agent model).',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ran: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          stats: { ...openObject },
        },
      },
      render: (_a, v) => text(v.message),
    },
    timeoutMs: 300_000,
    async execute() {
      if (!getConfig().CURATION_ENABLED) {
        return { ran: false, message: 'Curation is disabled. Set YAPA_CURATION_ENABLED=true (or the plugin `curationEnabled` setting) to enable.' };
      }
      try {
        const stats = await curationCycle();
        if (!stats) return { ran: false, message: 'Curation skipped — previous cycle still running.' };
        return {
          ran: true,
          message: `Curation cycle complete. Scored ${stats.scored}/${stats.pending} pending, ${stats.batches} batch(es), ${stats.errors} error(s).`,
          stats: JSON.parse(JSON.stringify(stats)),
        };
      } catch (e) {
        return { ran: false, message: `Curation error: ${e}` };
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Run curation cycle', kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_curation_status',
    description: 'Check curation status — enabled, model route, last run, cycle count, memories scored.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { lines: { type: 'array', required: true, items: { type: 'string' } } },
      },
      render: (_a, v) => text(v.lines.join('\n')),
    },
    isConcurrencySafe: () => true,
    async execute() {
      const cfg = getConfig();
      if (!cfg.CURATION_ENABLED) {
        return { lines: ['Curation is disabled. Set YAPA_CURATION_ENABLED=true to enable.'] };
      }
      const state = getCurationState();
      const lines = [
        `Curation: **enabled** (provider: ${cfg.CURATION_LLM_PROVIDER === 'anthropic' ? 'harness route (via auxProvider/default model)' : cfg.CURATION_LLM_PROVIDER}, model: ${getCurationModel() || 'harness default'}, interval: ${cfg.CURATION_INTERVAL_MS / 1000}s)`,
        `Background timer: ${state.timerActive ? 'active' : 'inactive'}`,
        `Cycles completed: ${state.cycleCount}`,
        `Memories scored this process: ${state.totalScored}`,
        state.lastRunAt ? `Last cycle: ${new Date(state.lastRunAt).toISOString()}` : 'Last cycle: never',
      ];
      if (state.lastError) lines.push(`Last error: ${state.lastError}`);
      return { lines };
    },
    presentCall: () => ({ card: 'generic', title: 'Curation status', kind: 'read' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_curation_preview',
    description: 'Dry-run the classifier on a small sample without persisting.',
    parameters: {
      collection: { type: 'string', description: 'Restrict sampling to this collection' },
      limit: { type: 'number', description: 'Max memories to classify (default 5)' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 120_000,
    async execute(args) {
      const limitNum = Math.max(1, Math.min(50, args.limit ?? 5));
      const collectionNames = args.collection
        ? [args.collection]
        : (await listCollections()).map(c => c.name);

      const sample: Array<{ id: string; content: string }> = [];
      for (const name of collectionNames) {
        if (sample.length >= limitNum) break;
        try {
          const docs = await getDocumentsByFilter(name, { type: 'memory' }, limitNum);
          for (const d of docs) {
            if (sample.length >= limitNum) break;
            sample.push({ id: d.id, content: d.content });
          }
        } catch { continue; }
      }
      if (sample.length === 0) return { text: 'No memories found to preview.' };

      try {
        const scored = await classifyMemories(sample);
        const blocks = scored.map(s => {
          const doc = sample.find(d => d.id === s.id);
          const preview = doc ? doc.content.slice(0, 140) + (doc.content.length > 140 ? '…' : '') : '';
          return `**${s.id}**\n  trainable: ${s.trainable.toFixed(2)} | durability: ${s.durability.toFixed(2)} | generalizability: ${s.generalizability.toFixed(2)}\n  rationale: ${s.rationale}\n  preview: ${preview}`;
        });
        return { text: blocks.join('\n\n---\n\n') };
      } catch (e) {
        return { text: `Curation preview error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Preview curation (${args.limit ?? 5} memories)`, kind: 'execute' }),
  }));

  // --- Buckets --------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_bucket_route_preview',
    description:
      'Dry-run: show which memories would be routed to the system-prompt prompt section and the '
      + 'training manifest, and why. No state change.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    isConcurrencySafe: () => true,
    async execute() {
      const preview = await bucketRoutePreview();
      const lines: string[] = [
        `System-prompt bucket (next version v${preview.systemPromptVersion}): ${preview.systemPromptCandidates.length} candidate(s)`,
        `  thresholds: trainable≥${preview.thresholds.systemPrompt.trainable}, durability≥${preview.thresholds.systemPrompt.durability}, generalizability≥${preview.thresholds.systemPrompt.generalizability}`,
        `Training bucket (next version v${preview.trainingVersion}): ${preview.trainingCandidates.length} candidate(s)`,
        `  thresholds: trainable≥${preview.thresholds.training.trainable}, durability≥${preview.thresholds.training.durability}, generalizability≥${preview.thresholds.training.generalizability}`,
      ];
      if (preview.systemPromptCandidates.length > 0) {
        lines.push('', '**System-prompt candidates:**');
        for (const c of preview.systemPromptCandidates.slice(0, 20)) {
          lines.push(`  - ${c.id} [${c.collection}]: ${c.reasons['system-prompt']}`);
        }
        if (preview.systemPromptCandidates.length > 20) lines.push(`  ...and ${preview.systemPromptCandidates.length - 20} more`);
      }
      if (preview.trainingCandidates.length > 0) {
        lines.push('', '**Training candidates:**');
        for (const c of preview.trainingCandidates.slice(0, 20)) {
          lines.push(`  - ${c.id} [${c.collection}]: ${c.reasons.training}`);
        }
        if (preview.trainingCandidates.length > 20) lines.push(`  ...and ${preview.trainingCandidates.length - 20} more`);
      }
      return { text: lines.join('\n') };
    },
    presentCall: () => ({ card: 'generic', title: 'Preview bucket routing', kind: 'search' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_bucket_route_now',
    description:
      'Execute bucket routing: tag qualifying memories with `selected_for` and write the '
      + 'training manifest. In DSH, system-prompt memories ALSO render live via the '
      + '`yapa:promoted` prompt section (no companion file wiring needed). Reversible via '
      + 'yapa_system_prompt_deactivate / training_cancel.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 120_000,
    async execute() {
      const result = await bucketRouteNow();
      const lines: string[] = [
        `System-prompt v${result.systemPromptVersion}: ${result.systemPromptCandidates.length} memory(ies)`,
        `Training v${result.trainingVersion}: ${result.trainingCandidates.length} memory(ies)`,
        `Tagged with selected_for: ${result.tagged}`,
        `Routing decisions: ${result.routingDecisionsPath}`,
      ];
      if (result.systemPromptArtifact) lines.push(`System-prompt companion: ${result.systemPromptArtifact.companionPath}`);
      if (result.trainingArtifact) lines.push(`Training manifest: ${result.trainingArtifact.manifestPath}`);
      lines.push('', 'Next steps:');
      if (result.systemPromptCandidates.length > 0) {
        lines.push('  - The promoted section updates automatically. Run `yapa_system_prompt_activate` with the version to hide those memories from default RAG.');
      }
      if (result.trainingCandidates.length > 0) {
        lines.push(`  - Run \`yapa_training_dataset_preview --manifest_version ${result.trainingVersion}\` when ready.`);
      }
      return { text: lines.join('\n') };
    },
    presentCall: () => ({ card: 'generic', title: 'Route memories into buckets', kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_bucket_status',
    description: 'Show current bucket state: counts of memories in selected_for vs promoted_to for each bucket + version.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    isConcurrencySafe: () => true,
    async execute() {
      const status = await bucketStatus();
      const lines: string[] = [
        `Pending classification: ${status.pendingClassification}`,
        '',
        '**Selected (intermediate — still visible in RAG):**',
      ];
      const selKeys = Object.keys(status.bySelection).sort();
      if (selKeys.length === 0) lines.push('  (none)');
      else for (const k of selKeys) lines.push(`  - ${k}: ${status.bySelection[k]}`);
      lines.push('', '**Promoted (hidden from default RAG):**');
      const promKeys = Object.keys(status.byPromotion).sort();
      if (promKeys.length === 0) lines.push('  (none)');
      else for (const k of promKeys) lines.push(`  - ${k}: ${status.byPromotion[k]}`);
      return { text: lines.join('\n') };
    },
    presentCall: () => ({ card: 'generic', title: 'Bucket status', kind: 'read' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_system_prompt_activate',
    description:
      'Confirm a system-prompt companion version is live (the DSH promoted section renders it '
      + 'automatically). Transitions its memories from selected_for → promoted_to so they no '
      + 'longer appear in default yapa_memory_recall results.',
    parameters: {
      version: { type: 'integer', required: true, description: 'Companion version to activate (from yapa_bucket_route_now output)' },
      confirm: confirmParam,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const { promoted } = await systemPromptActivate(args.version);
      return { text: `Activated system-prompt-v${args.version}. ${promoted} memory(ies) promoted from selected_for → promoted_to and are now hidden from default RAG.` };
    },
    presentCall: args => ({ card: 'generic', title: `Activate system-prompt v${args.version}`, kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_system_prompt_deactivate',
    description: 'Rollback a previously-activated system-prompt companion version; memories reappear in default RAG.',
    parameters: {
      version: { type: 'integer', required: true },
      confirm: confirmParam,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      const { rolledBack } = await systemPromptDeactivate(args.version);
      return { text: `Deactivated system-prompt-v${args.version}. ${rolledBack} memory(ies) rolled back — now visible in default RAG again.` };
    },
    presentCall: args => ({ card: 'generic', title: `Deactivate system-prompt v${args.version}`, kind: 'execute' }),
  }));

  // --- Training / eval / promotion -------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_training_dataset_preview',
    description:
      'Read a training manifest, run synthesis (memory → chat-format training examples), and '
      + 'write a preview JSONL. Returns a SHA-256 reference you must pass back to yapa_training_trigger.',
    parameters: {
      manifest_version: { type: 'integer', required: true, description: 'Manifest version from yapa_bucket_route_now' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 300_000,
    async execute(args) {
      try {
        const result = await trainingDatasetPreview(args.manifest_version);
        const lines = [
          `Preview written: ${result.previewPath}`,
          `preview_ref (sha256): ${result.previewRef}`,
          `Examples: ${result.exampleCount}`,
          `Memories skipped (synthesis returned empty or errored): ${result.skippedMemories}`,
          '',
          `Next step: review the preview file, then call yapa_training_trigger with manifest_version=${result.manifestVersion}, preview_path=<path above>, preview_ref=<sha256 above>, confirm=true.`,
        ];
        return { text: lines.join('\n') };
      } catch (e) {
        return { text: `Preview error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Preview training dataset v${args.manifest_version}`, kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_training_trigger',
    description:
      'Submit a training job (spends money on the training backend). Requires confirm=true AND '
      + 'a matching preview_ref from yapa_training_dataset_preview. The preview file on disk '
      + 'must hash to preview_ref — if it was modified, this refuses.',
    parameters: {
      manifest_version: { type: 'integer', required: true },
      preview_path: { type: 'string', required: true, description: 'Absolute path to the preview JSONL generated by yapa_training_dataset_preview' },
      preview_ref: { type: 'string', required: true, description: 'SHA-256 hex returned by yapa_training_dataset_preview' },
      confirm: confirmParam,
      adapter_id: { type: 'string', description: 'Optional custom adapter id (auto-generated otherwise)' },
      hyperparameters: {
        ...openObject,
        description: 'Optional: epochs, learningRate, loraRank, earlyStop',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 120_000,
    async execute(args) {
      if (args.confirm !== true) return { text: 'Refused — `confirm: true` is required.' };
      try {
        const result = await trainingTrigger({
          manifestVersion: args.manifest_version,
          previewPath: args.preview_path,
          previewRef: args.preview_ref,
          confirm: true,
          adapterId: args.adapter_id,
          hyperparameters: args.hyperparameters as Record<string, number | boolean> | undefined,
        });
        return { text: `Submitted training job. adapter_id=${result.adapterId} backend=${result.handle.backend} job_id=${result.handle.jobId}` };
      } catch (e) {
        return { text: `Trigger error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Trigger training on manifest v${args.manifest_version}`, kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_training_status',
    description: 'List all training runs in the adapter registry with their current status.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    isConcurrencySafe: () => true,
    async execute() {
      const { adapters } = await trainingStatus();
      if (adapters.length === 0) return { text: 'No training runs in the registry.' };
      const out = adapters.map(a => {
        const parts = [
          `**${a.id}** [${a.status}]`,
          `  base: ${a.baseModel}`,
          `  backend: ${a.backend}${a.backendJobId ? ' / ' + a.backendJobId : ''}`,
          `  manifest: v${a.manifestVersion}`,
        ];
        if (a.outputModelRef) parts.push(`  output: ${a.outputModelRef}`);
        if (a.error) parts.push(`  error: ${a.error}`);
        return parts.join('\n');
      }).join('\n\n');
      return { text: out };
    },
    presentCall: () => ({ card: 'generic', title: 'List training runs', kind: 'read' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_training_get',
    description: 'Get details on a single training run. Polls the backend for live status if still pending/running.',
    parameters: {
      adapter_id: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 60_000,
    async execute(args) {
      const result = await trainingGet(args.adapter_id);
      if (!result) return { text: `Adapter ${args.adapter_id} not found in registry.` };
      const { entry, remoteStatus } = result;
      const lines = [
        `**${entry.id}** [${entry.status}]`,
        `  base: ${entry.baseModel}`,
        `  backend: ${entry.backend}${entry.backendJobId ? ' / ' + entry.backendJobId : ''}`,
        `  manifest: v${entry.manifestVersion}`,
        `  dataset: ${entry.datasetPath}`,
        `  preview_ref: ${entry.previewRef.slice(0, 12)}…`,
        `  created: ${new Date(entry.createdAt * 1000).toISOString()}`,
        `  updated: ${new Date(entry.updatedAt * 1000).toISOString()}`,
      ];
      if (entry.outputModelRef) lines.push(`  output: ${entry.outputModelRef}`);
      if (entry.error) lines.push(`  error: ${entry.error}`);
      if (remoteStatus) {
        lines.push('', `remote state: ${remoteStatus.state}`);
        if (remoteStatus.error) lines.push(`remote error: ${remoteStatus.error}`);
      }
      return { text: lines.join('\n') };
    },
    presentCall: args => ({ card: 'generic', title: `Get training run ${args.adapter_id}`, kind: 'read' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_training_cancel',
    description: 'Cancel an in-flight training run. Also clears selected_for on all memories routed into its manifest.',
    parameters: {
      adapter_id: { type: 'string', required: true },
      confirm: confirmParam,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 60_000,
    async execute(args) {
      const entry = await trainingCancel(args.adapter_id);
      if (!entry) return { text: `Adapter ${args.adapter_id} not found.` };
      return { text: `Cancelled ${args.adapter_id}. Memories from manifest v${entry.manifestVersion} returned to default RAG visibility.` };
    },
    presentCall: args => ({ card: 'generic', title: `Cancel training run ${args.adapter_id}`, kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_eval_run',
    description:
      'Run aggregate eval on a trained adapter against the holdout slice of its training '
      + 'manifest. Returns an average 0-1 score and per-item detail. Incurs inference cost.',
    parameters: {
      adapter_id: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 600_000,
    async execute(args) {
      try {
        const entry = getAdapter(args.adapter_id);
        if (!entry) return { text: `Adapter ${args.adapter_id} not in registry.` };
        if (!entry.outputModelRef) return { text: `Adapter ${args.adapter_id} has no outputModelRef yet. Poll yapa_training_get first.` };
        const result = await evalRun({ adapterRef: entry.outputModelRef, manifestVersion: entry.manifestVersion });
        updateAdapter(args.adapter_id, { evalScore: result.averageScore });
        const lines = [
          `Eval for ${args.adapter_id}:`,
          `  items: ${result.itemCount}`,
          `  average score: ${result.averageScore.toFixed(3)}`,
          '',
          ...result.items.slice(0, 10).map(i => `  - ${i.memoryId}: score=${i.score.toFixed(2)} winner=${i.winner} — ${i.rationale}`),
        ];
        if (result.items.length > 10) lines.push(`  ...and ${result.items.length - 10} more`);
        return { text: lines.join('\n') };
      } catch (e) {
        return { text: `Eval error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Eval adapter ${args.adapter_id}`, kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_eval_compare',
    description: 'Side-by-side eval comparison of two adapters on the same holdout.',
    parameters: {
      adapter_id_a: { type: 'string', required: true },
      adapter_id_b: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 600_000,
    async execute(args) {
      try {
        const a = getAdapter(args.adapter_id_a);
        const b = getAdapter(args.adapter_id_b);
        if (!a || !b) return { text: 'Both adapters must exist in the registry.' };
        if (a.manifestVersion !== b.manifestVersion) {
          return { text: `Refusing — adapters trained on different manifests (v${a.manifestVersion} vs v${b.manifestVersion}).` };
        }
        if (!a.outputModelRef || !b.outputModelRef) {
          return { text: 'Both adapters must have outputModelRef. Poll yapa_training_get.' };
        }
        const result = await evalCompare(a.outputModelRef, b.outputModelRef, a.manifestVersion);
        const lines = [
          `${args.adapter_id_a}: avg ${result.adapterA.averageScore.toFixed(3)}`,
          `${args.adapter_id_b}: avg ${result.adapterB.averageScore.toFixed(3)}`,
          `delta (B-A): ${result.delta.toFixed(3)}`,
          `winner: ${result.winner}`,
        ];
        return { text: lines.join('\n') };
      } catch (e) {
        return { text: `Compare error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Compare ${args.adapter_id_a} vs ${args.adapter_id_b}`, kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_eval_verify',
    description:
      'Per-memory verification: for every memory in the adapter\'s training manifest, query the '
      + 'adapter and judge whether the answer covers the memory. Requires YAPA_VERIFICATION_ENABLED=true.',
    parameters: {
      adapter_id: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 600_000,
    async execute(args) {
      try {
        const entry = getAdapter(args.adapter_id);
        if (!entry) return { text: `Adapter ${args.adapter_id} not in registry.` };
        if (!entry.outputModelRef) return { text: 'Adapter has no outputModelRef yet.' };
        const result = await verifyAdapterAgainstManifest(entry.outputModelRef, entry.manifestVersion);
        const lines = [
          `Verification for ${args.adapter_id}:`,
          `  passed: ${result.passedCount}`,
          `  failed: ${result.failedCount}`,
          '',
          ...result.items.slice(0, 15).map(i => `  - ${i.memoryId}: ${i.passed ? 'PASS' : 'FAIL'} (conf ${i.confidence.toFixed(2)}) — ${i.rationale}`),
        ];
        if (result.items.length > 15) lines.push(`  ...and ${result.items.length - 15} more`);
        lines.push('', 'Next: call yapa_adapter_promote to move verified memories out of default RAG.');
        return { text: lines.join('\n') };
      } catch (e) {
        return { text: `Verify error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Verify adapter ${args.adapter_id} per-memory`, kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_adapter_promote',
    description:
      'Promote a trained adapter: transition verified memories from selected_for → promoted_to. '
      + 'Requires the adapter to be completed and verification to have run.',
    parameters: {
      adapter_id: { type: 'string', required: true },
      confirm: confirmParam,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      try {
        const result = await adapterPromote({ adapterId: args.adapter_id, confirm: true });
        const lines = [
          `Promoted adapter ${result.adapterId} (manifest v${result.manifestVersion}).`,
          `  Memories promoted (hidden from default RAG): ${result.promoted}`,
          `  Memories rolled back (failed verification, back in RAG): ${result.rolledBackSelections}`,
        ];
        if (result.outputModelRef) lines.push(`  Adapter ref: ${result.outputModelRef}`);
        return { text: lines.join('\n') };
      } catch (e) {
        return { text: `Promote error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Promote adapter ${args.adapter_id}`, kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_adapter_demote',
    description: 'Rollback an adapter promotion; restores full RAG visibility for its memories.',
    parameters: {
      adapter_id: { type: 'string', required: true },
      confirm: confirmParam,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      try {
        const result = await adapterDemote(args.adapter_id);
        return { text: `Demoted ${result.adapterId}. ${result.rolledBack} memory(ies) returned to default RAG.` };
      } catch (e) {
        return { text: `Demote error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Demote adapter ${args.adapter_id}`, kind: 'execute' }),
  }));

  // --- Sync -----------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_sync_status',
    description: 'Check remote sync status — connection health, last sync times, pending items.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    async execute() {
      const cfg = getConfig();
      if (!cfg.SYNC_ENABLED) return { text: 'Remote sync is disabled. Set syncEnabled in the plugin config or YAPA_SYNC_ENABLED=true to enable.' };
      const lines = [`Sync: **enabled** (interval: ${cfg.SYNC_INTERVAL_MS / 1000}s)`];
      lines.push(`Remote: ${cfg.SYNC_DATABASE_URL ? cfg.SYNC_DATABASE_URL.replace(/:[^:@]*@/, ':***@') : 'not configured'}`);
      try {
        const health = await checkRemoteHealth();
        lines.push(`Connection: ${health.ok ? 'healthy' : `error — ${health.error}`}`);
      } catch (e) {
        lines.push(`Connection: error — ${e}`);
      }
      try {
        const lastPull = await getSyncPullTimestamp();
        lines.push(`Last pull: ${lastPull ? new Date(lastPull * 1000).toISOString() : 'never'}`);
      } catch { lines.push('Last pull: unknown'); }
      try {
        const pending = await getPendingDeletes();
        if (pending.length > 0) lines.push(`Pending deletes: ${pending.length}`);
      } catch { /* ignore */ }
      try {
        const state = getSyncState();
        lines.push(`Background timer: ${state.timerActive ? 'active' : 'inactive'}`);
        lines.push(`Cycles completed: ${state.cycleCount}`);
        if (state.lastCycleAt) lines.push(`Last cycle: ${new Date(state.lastCycleAt).toISOString()}`);
        if (state.lastCycleError) lines.push(`Last error: ${state.lastCycleError}`);
      } catch { lines.push('Background state: unavailable'); }
      return { text: lines.join('\n') };
    },
    presentCall: () => ({ card: 'generic', title: 'Sync status', kind: 'read' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_sync_now',
    description: 'Trigger an immediate sync cycle (push then pull).',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 300_000,
    async execute() {
      if (!getConfig().SYNC_ENABLED) return { text: 'Remote sync is disabled.' };
      try {
        const stats = await syncCycle();
        if (!stats) return { text: 'Sync skipped — previous cycle still running.' };
        const { push, pull } = stats;
        return { text: `Sync cycle completed. Push: ${push.pushed} new, ${push.linked} linked, ${push.deleted} deleted, ${push.errors} errors | Pull: ${pull.pulled} new, ${pull.linked} linked, ${pull.skipped} skipped, ${pull.errors} errors` };
      } catch (e) {
        return { text: `Sync error: ${e}` };
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Run sync cycle', kind: 'execute' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_sync_remote_collections',
    description: 'List collections available on the remote database with subscription status.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    async execute() {
      if (!getConfig().SYNC_ENABLED) return { text: 'Remote sync is disabled.' };
      try {
        const [remote, subscriptions] = await Promise.all([getRemoteCollections(), getSyncSubscriptions()]);
        const subSet = new Set(subscriptions);
        if (remote.length === 0) return { text: 'No collections found on remote.' };
        return { text: remote.map(r => `- **${r.name}**: ${r.count} docs ${subSet.has(r.name) ? '(subscribed)' : ''}`).join('\n') };
      } catch (e) {
        return { text: `Error querying remote: ${e}` };
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List remote collections', kind: 'search' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_sync_subscribe',
    description: 'Subscribe to remote collections for pull sync.',
    parameters: {
      collections: { type: 'array', required: true, items: { type: 'string' }, description: 'Collection names to subscribe to' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 120_000,
    async execute(args) {
      if (!getConfig().SYNC_ENABLED) return { text: 'Remote sync is disabled.' };
      try {
        const remote = await getRemoteCollections();
        const remoteNames = new Set(remote.map(r => r.name));
        const valid: string[] = [];
        const invalid: string[] = [];
        for (const name of args.collections) {
          if (remoteNames.has(name)) valid.push(name);
          else invalid.push(name);
        }
        if (valid.length === 0) {
          return { text: `None of the requested collections exist on remote. Available: ${[...remoteNames].join(', ')}` };
        }
        const existing = await getSyncSubscriptions();
        await updateSyncSubscriptions([...new Set([...existing, ...valid])]);
        for (const name of valid) await getOrCreateCollection(name);
        await syncCycle();
        const lines = [`Subscribed to: ${valid.join(', ')}`];
        if (invalid.length > 0) lines.push(`Not found on remote: ${invalid.join(', ')}`);
        return { text: lines.join('\n') };
      } catch (e) {
        return { text: `Error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Subscribe to ${args.collections.join(', ')}`, kind: 'edit' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_sync_unsubscribe',
    description: 'Unsubscribe from remote collections (local data is kept).',
    parameters: {
      collections: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    async execute(args) {
      if (!getConfig().SYNC_ENABLED) return { text: 'Remote sync is disabled.' };
      try {
        const existing = await getSyncSubscriptions();
        const removeSet = new Set(args.collections);
        await updateSyncSubscriptions(existing.filter(c => !removeSet.has(c)));
        const removed = args.collections.filter(c => existing.includes(c));
        const notFound = args.collections.filter(c => !existing.includes(c));
        const lines: string[] = [];
        if (removed.length > 0) lines.push(`Unsubscribed from: ${removed.join(', ')}`);
        if (notFound.length > 0) lines.push(`Not subscribed: ${notFound.join(', ')}`);
        lines.push('Local data has been kept.');
        return { text: lines.join('\n') };
      } catch (e) {
        return { text: `Error: ${e}` };
      }
    },
    presentCall: args => ({ card: 'generic', title: `Unsubscribe ${args.collections.join(', ')}`, kind: 'edit' }),
  }));

  // --- Storage migration -----------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_storage_import',
    description:
      'Import all documents from ChromaDB into the embedded local store. Requires the plugin to '
      + 'be running with storage: local (the import target is the ACTIVE store) and a reachable '
      + 'ChromaDB at chromaUrl (the source). Re-embeds documents with the current embedder, so '
      + 'switching embedding providers mid-stream is safe.',
    parameters: {
      collections: { type: 'array', items: { type: 'string' }, description: 'Collections to import (default: all on the ChromaDB server)' },
      confirm: confirmParam,
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_a, v) => text(v.text),
    },
    timeoutMs: 600_000,
    async execute(args) {
      if (args.confirm !== true) return { text: 'Refused — `confirm: true` is required.' };
      const cfg = getConfig();
      if (cfg.STORAGE !== 'local') {
        return { text: 'Refused — the active store is chroma. Set `storage: local` (plugin config or settings.yaml `yapa:`) first, then re-run.' };
      }
      const target = getStore();
      if (target.kind !== 'local') {
        return { text: `Refused — active store is "${target.kind}", expected local. Restart after changing storage config.` };
      }
      try {
        const sourceCols = args.collections?.length
          ? args.collections
          : (await chromaStore.listCollections()).map(c => c.name);
        const lines: string[] = [`Importing from ChromaDB at ${cfg.CHROMA_URL} → local store at ${cfg.LOCAL_STORE_PATH}:`];
        let total = 0;
        for (const name of sourceCols) {
          const docs = await chromaStore.getDocumentsByFilter(name, {}, 100000);
          if (docs.length === 0) { lines.push(`  - ${name}: 0 documents`); continue; }
          await target.getOrCreateCollection(name);
          await target.addDocumentsBatch(
            name,
            docs.map(d => ({ id: d.id, content: d.content, metadata: d.metadata })),
          );
          total += docs.length;
          lines.push(`  - ${name}: ${docs.length} document(s)`);
        }
        lines.push('', `Imported ${total} document(s) across ${sourceCols.length} collection(s).`);
        return { text: lines.join('\n') };
      } catch (e) {
        return { text: `Import error: ${e}` };
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Import from ChromaDB${args.collections?.length ? `: ${args.collections.join(', ')}` : ' (all collections)'}`,
      kind: 'move',
    }),
  }));
}
