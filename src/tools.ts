import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { setupInstructions } from './instructions.js';
import { storeMemory } from './memory/store.js';
import { recallMemory } from './memory/recall.js';
import { forgetMemory } from './memory/forget.js';
import { listMemories } from './memory/list.js';
import { runDecaySweep } from './memory/decay.js';
import { createTask } from './tasks/create.js';
import { listTasks, getDueTasks } from './tasks/list.js';
import { getTask, updateTask, completeTask } from './tasks/update.js';
import { searchTasks } from './tasks/search.js';
import { deleteTask } from './tasks/delete.js';
import { addDependency } from './tasks/dependencies.js';
import { parseRelativeDate, formatTaskDate } from './tasks/dates.js';
import { listCollectionsWithCounts, createNewCollection, removeCollection } from './collections/manage.js';

export function registerTools(server: McpServer): void {
  // --- Setup ---
  server.tool(
    'setup_instructions',
    'Auto-detect CLAUDE.md vs AGENTS.md and generate behavioral instructions for YAPA',
    {
      target: z.enum(['auto', 'claude', 'opencode']).optional().describe('Override target detection'),
      cwd: z.string().optional().describe('Working directory to check (defaults to process.cwd())'),
      scope: z.enum(['project', 'global']).optional().describe('project = cwd only, global = home dir (all sessions). Default: project'),
    },
    async ({ target, cwd, scope }) => {
      const result = setupInstructions(cwd ?? process.cwd(), target ?? 'auto', scope ?? 'project');
      return {
        content: [{
          type: 'text' as const,
          text: `Instructions ${result.action} at ${result.file} (target: ${result.target}, scope: ${scope ?? 'project'})\n\n${result.instructions}`,
        }],
      };
    },
  );

  // --- Memory ---
  server.tool(
    'memory_store',
    'Store a memory with content, tags, salience, sector, and collection',
    {
      content: z.string().describe('The memory content to store'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      salience: z.number().optional().describe('Importance score (0.0-5.0, default 1.0)'),
      sector: z.enum(['semantic', 'episodic']).optional().describe('Memory type (auto-detected if omitted)'),
      collection: z.string().optional().describe('Collection name (default: global)'),
    },
    async ({ content, tags, salience, sector, collection }) => {
      const ids = await storeMemory(content, { tags, salience, sector, collection });
      return {
        content: [{ type: 'text' as const, text: `Stored memory: ${ids.join(', ')}` }],
      };
    },
  );

  server.tool(
    'memory_recall',
    'Semantic search for memories with optional collection/tag filters. Results are ranked by a combination of vector distance and salience. Promoted memories (already moved to the system-prompt companion or a trained adapter) are excluded by default.',
    {
      query: z.string().describe('Semantic search query'),
      collection: z.string().optional().describe('Limit search to this collection'),
      n_results: z.number().optional().describe('Max results (default 5)'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      include_promoted: z.boolean().optional().describe('Include memories already promoted to system-prompt or training buckets. Default: false.'),
      filters: z.object({
        trainable_min: z.number().min(0).max(1).optional().describe('Minimum trainable score (0-1)'),
        durability_min: z.number().min(0).max(1).optional().describe('Minimum durability score (0-1)'),
        generalizability_min: z.number().min(0).max(1).optional().describe('Minimum generalizability score (0-1)'),
        classified: z.boolean().optional().describe('If true, only classified memories. If false, only unclassified.'),
      }).optional().describe('Optional range filters on classifier scores'),
    },
    async ({ query, collection, n_results, tags, include_promoted, filters }) => {
      const results = await recallMemory(query, {
        collection,
        nResults: n_results,
        tags,
        include_promoted,
        filters,
      });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
      }
      const text = results.map(r =>
        `**${r.id}** (${r.collection ?? 'unknown'}, salience: ${r.metadata.salience?.toFixed(2) ?? '?'}, distance: ${r.distance.toFixed(3)})\n${r.content}`
      ).join('\n\n---\n\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'memory_forget',
    'Delete a memory by ID (searches across all collections)',
    {
      id: z.string().describe('Memory document ID to delete'),
    },
    async ({ id }) => {
      const collection = await forgetMemory(id);
      return {
        content: [{ type: 'text' as const, text: `Deleted ${id} from collection "${collection}"` }],
      };
    },
  );

  server.tool(
    'memory_list',
    'List memories with optional metadata filters. Promoted memories are excluded by default.',
    {
      collection: z.string().optional().describe('Filter by collection'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      sector: z.enum(['semantic', 'episodic']).optional().describe('Filter by sector'),
      limit: z.number().optional().describe('Max results (default 50)'),
      include_promoted: z.boolean().optional().describe('Include memories already promoted to system-prompt or training buckets. Default: false.'),
      filters: z.object({
        trainable_min: z.number().min(0).max(1).optional().describe('Minimum trainable score (0-1)'),
        durability_min: z.number().min(0).max(1).optional().describe('Minimum durability score (0-1)'),
        generalizability_min: z.number().min(0).max(1).optional().describe('Minimum generalizability score (0-1)'),
        classified: z.boolean().optional().describe('If true, only classified memories. If false, only unclassified.'),
      }).optional().describe('Optional range filters on classifier scores'),
    },
    async ({ collection, tags, sector, limit, include_promoted, filters }) => {
      const results = await listMemories({
        collection,
        tags,
        sector,
        limit,
        include_promoted,
        filters,
      });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
      }
      const text = results.map(r => {
        const promoted = r.metadata.promoted_to ? ` promoted: ${r.metadata.promoted_to}` : '';
        const selected = r.metadata.selected_for ? ` selected: ${r.metadata.selected_for}` : '';
        return `- **${r.id}** [${r.collection}] (salience: ${r.metadata.salience?.toFixed(2) ?? '?'}, sector: ${r.metadata.sector ?? '?'}${selected}${promoted}): ${r.content.slice(0, 100)}${r.content.length > 100 ? '...' : ''}`;
      }).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // --- Curation ---
  server.tool(
    'curation_now',
    'Trigger an immediate curation cycle: classifies unscored memories with trainable/durability/generalizability scores.',
    {},
    async () => {
      const { CURATION_ENABLED } = await import('./config.js');
      if (!CURATION_ENABLED) {
        return { content: [{ type: 'text' as const, text: 'Curation is disabled. Set YAPA_CURATION_ENABLED=true to enable.' }] };
      }
      try {
        const { curationCycle } = await import('./curation/index.js');
        const stats = await curationCycle();
        if (!stats) {
          return { content: [{ type: 'text' as const, text: 'Curation skipped — previous cycle still running.' }] };
        }
        const text = `Curation cycle complete. Scored ${stats.scored}/${stats.pending} pending, ${stats.batches} batch(es), ${stats.errors} error(s).`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Curation error: ${e}` }] };
      }
    },
  );

  server.tool(
    'curation_status',
    'Check curation status — enabled, provider, last run, cycle count, memories scored.',
    {},
    async () => {
      const { CURATION_ENABLED, CURATION_INTERVAL_MS, CURATION_LLM_PROVIDER, getCurationModel } = await import('./config.js');
      if (!CURATION_ENABLED) {
        return { content: [{ type: 'text' as const, text: 'Curation is disabled. Set YAPA_CURATION_ENABLED=true to enable.' }] };
      }
      const { getCurationState } = await import('./curation/index.js');
      const state = getCurationState();
      const lines = [
        `Curation: **enabled** (provider: ${CURATION_LLM_PROVIDER}, model: ${getCurationModel()}, interval: ${CURATION_INTERVAL_MS / 1000}s)`,
        `Background timer: ${state.timerActive ? 'active' : 'inactive'}`,
        `Cycles completed: ${state.cycleCount}`,
        `Memories scored this process: ${state.totalScored}`,
        state.lastRunAt ? `Last cycle: ${new Date(state.lastRunAt).toISOString()}` : 'Last cycle: never',
      ];
      if (state.lastError) lines.push(`Last error: ${state.lastError}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'curation_preview',
    'Dry-run the classifier on a small sample without persisting. Useful for sanity-checking prompt output before running a full cycle.',
    {
      collection: z.string().optional().describe('Restrict sampling to this collection'),
      limit: z.number().optional().describe('Max memories to classify (default 5)'),
    },
    async ({ collection, limit }) => {
      const limitNum = Math.max(1, Math.min(50, limit ?? 5));
      const { getDocumentsByFilter, listCollections } = await import('./chroma.js');
      const { classifyMemories } = await import('./curation/classifier.js');

      const collectionNames = collection
        ? [collection]
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
        } catch {
          continue;
        }
      }

      if (sample.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found to preview.' }] };
      }

      try {
        const scored = await classifyMemories(sample);
        const blocks = scored.map(s => {
          const doc = sample.find(d => d.id === s.id);
          const preview = doc ? doc.content.slice(0, 140) + (doc.content.length > 140 ? '…' : '') : '';
          return `**${s.id}**\n  trainable: ${s.trainable.toFixed(2)} | durability: ${s.durability.toFixed(2)} | generalizability: ${s.generalizability.toFixed(2)}\n  rationale: ${s.rationale}\n  preview: ${preview}`;
        });
        return { content: [{ type: 'text' as const, text: blocks.join('\n\n---\n\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Curation preview error: ${e}` }] };
      }
    },
  );

  // --- Buckets ---
  server.tool(
    'bucket_route_preview',
    'Dry-run: show which memories would be routed to the system-prompt companion and training manifest, and why. No state change.',
    {},
    async () => {
      const { bucketRoutePreview } = await import('./buckets/index.js');
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
        if (preview.systemPromptCandidates.length > 20) {
          lines.push(`  ...and ${preview.systemPromptCandidates.length - 20} more`);
        }
      }
      if (preview.trainingCandidates.length > 0) {
        lines.push('', '**Training candidates:**');
        for (const c of preview.trainingCandidates.slice(0, 20)) {
          lines.push(`  - ${c.id} [${c.collection}]: ${c.reasons.training}`);
        }
        if (preview.trainingCandidates.length > 20) {
          lines.push(`  ...and ${preview.trainingCandidates.length - 20} more`);
        }
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'bucket_route_now',
    'Execute bucket routing: write the system-prompt companion file and training-manifest JSONL, then tag qualifying memories with `selected_for`. Memories remain visible in default RAG until a bucket-specific activation step runs (system_prompt_activate, or adapter_promote in Phase 4).',
    {},
    async () => {
      const { bucketRouteNow } = await import('./buckets/index.js');
      const result = await bucketRouteNow();
      const lines: string[] = [
        `System-prompt v${result.systemPromptVersion}: ${result.systemPromptCandidates.length} memory(ies)`,
        `Training v${result.trainingVersion}: ${result.trainingCandidates.length} memory(ies)`,
        `Tagged with selected_for: ${result.tagged}`,
        `Routing decisions: ${result.routingDecisionsPath}`,
      ];
      if (result.systemPromptArtifact) {
        lines.push(`System-prompt companion: ${result.systemPromptArtifact.companionPath}`);
      }
      if (result.trainingArtifact) {
        lines.push(`Training manifest: ${result.trainingArtifact.manifestPath}`);
      }
      lines.push('', 'Next steps:');
      if (result.systemPromptCandidates.length > 0) {
        lines.push(`  - Review the companion file, wire it into your workflow, then run \`system_prompt_activate --version ${result.systemPromptVersion}\` to hide those memories from default RAG.`);
      }
      if (result.trainingCandidates.length > 0) {
        lines.push(`  - Run \`training_dataset_preview --manifest v${result.trainingVersion}\` when Phase 3 is live.`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'bucket_status',
    'Show current bucket state: counts of memories in selected_for vs promoted_to for each bucket + version.',
    {},
    async () => {
      const { bucketStatus } = await import('./buckets/index.js');
      const status = await bucketStatus();
      const lines: string[] = [
        `Pending classification: ${status.pendingClassification}`,
        '',
        '**Selected (intermediate — still visible in RAG):**',
      ];
      const selKeys = Object.keys(status.bySelection).sort();
      if (selKeys.length === 0) {
        lines.push('  (none)');
      } else {
        for (const k of selKeys) lines.push(`  - ${k}: ${status.bySelection[k]}`);
      }
      lines.push('', '**Promoted (hidden from default RAG):**');
      const promKeys = Object.keys(status.byPromotion).sort();
      if (promKeys.length === 0) {
        lines.push('  (none)');
      } else {
        for (const k of promKeys) lines.push(`  - ${k}: ${status.byPromotion[k]}`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'system_prompt_activate',
    'Confirm that a system-prompt companion version is now being consumed by your workflow. Transitions its memories from selected_for → promoted_to so they no longer appear in default memory_recall results.',
    {
      version: z.number().int().positive().describe('Companion version to activate (from bucket_route_now output)'),
      confirm: z.literal(true).describe('Required safety flag — must be true'),
    },
    async ({ version, confirm }) => {
      if (confirm !== true) {
        return { content: [{ type: 'text' as const, text: 'Refused — `confirm: true` is required.' }] };
      }
      const { systemPromptActivate } = await import('./buckets/index.js');
      const { promoted } = await systemPromptActivate(version);
      const text = `Activated system-prompt-v${version}. ${promoted} memory(ies) promoted from selected_for → promoted_to and are now hidden from default RAG.`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'system_prompt_deactivate',
    'Rollback a previously-activated system-prompt companion version. Clears promoted_to on all affected memories so they reappear in default RAG.',
    {
      version: z.number().int().positive().describe('Companion version to deactivate'),
      confirm: z.literal(true).describe('Required safety flag — must be true'),
    },
    async ({ version, confirm }) => {
      if (confirm !== true) {
        return { content: [{ type: 'text' as const, text: 'Refused — `confirm: true` is required.' }] };
      }
      const { systemPromptDeactivate } = await import('./buckets/index.js');
      const { rolledBack } = await systemPromptDeactivate(version);
      const text = `Deactivated system-prompt-v${version}. ${rolledBack} memory(ies) rolled back — now visible in default RAG again.`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // --- Training ---
  server.tool(
    'training_dataset_preview',
    'Read a training manifest, run synthesis (memory → chat-format training examples), and write a preview JSONL. Returns a SHA-256 reference you must pass back to training_trigger.',
    {
      manifest_version: z.number().int().positive().describe('Manifest version from bucket_route_now'),
    },
    async ({ manifest_version }) => {
      try {
        const { trainingDatasetPreview } = await import('./training/index.js');
        const result = await trainingDatasetPreview(manifest_version);
        const lines = [
          `Preview written: ${result.previewPath}`,
          `preview_ref (sha256): ${result.previewRef}`,
          `Examples: ${result.exampleCount}`,
          `Memories skipped (synthesis returned empty or errored): ${result.skippedMemories}`,
          '',
          `Next step: review the preview file, then call training_trigger with manifest_version=${result.manifestVersion}, preview_path=<path above>, preview_ref=<sha256 above>, confirm=true.`,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Preview error: ${e}` }] };
      }
    },
  );

  server.tool(
    'training_trigger',
    'Submit a training job. Requires confirm=true AND a matching preview_ref from training_dataset_preview. The preview file on disk must hash to preview_ref — if it was modified, this refuses.',
    {
      manifest_version: z.number().int().positive(),
      preview_path: z.string().describe('Absolute path to the preview JSONL generated by training_dataset_preview'),
      preview_ref: z.string().describe('SHA-256 hex returned by training_dataset_preview'),
      confirm: z.literal(true).describe('Required safety flag — must be true'),
      adapter_id: z.string().optional().describe('Optional custom adapter id (auto-generated otherwise)'),
      hyperparameters: z.object({
        epochs: z.number().optional(),
        learningRate: z.number().optional(),
        loraRank: z.number().optional(),
        earlyStop: z.boolean().optional(),
      }).optional(),
    },
    async ({ manifest_version, preview_path, preview_ref, confirm, adapter_id, hyperparameters }) => {
      try {
        const { trainingTrigger } = await import('./training/index.js');
        const result = await trainingTrigger({
          manifestVersion: manifest_version,
          previewPath: preview_path,
          previewRef: preview_ref,
          confirm,
          adapterId: adapter_id,
          hyperparameters,
        });
        return {
          content: [{
            type: 'text' as const,
            text: `Submitted training job. adapter_id=${result.adapterId} backend=${result.handle.backend} job_id=${result.handle.jobId}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Trigger error: ${e}` }] };
      }
    },
  );

  server.tool(
    'training_status',
    'List all training runs in the adapter registry with their current status.',
    {},
    async () => {
      const { trainingStatus } = await import('./training/index.js');
      const { adapters } = await trainingStatus();
      if (adapters.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No training runs in the registry.' }] };
      }
      const text = adapters.map(a => {
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
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'training_get',
    'Get details on a single training run. Polls the backend for live status if the run is still pending/running.',
    {
      adapter_id: z.string(),
    },
    async ({ adapter_id }) => {
      const { trainingGet } = await import('./training/index.js');
      const result = await trainingGet(adapter_id);
      if (!result) {
        return { content: [{ type: 'text' as const, text: `Adapter ${adapter_id} not found in registry.` }] };
      }
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
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'training_cancel',
    'Cancel an in-flight training run. Also clears selected_for on all memories routed into its manifest (they return to full RAG visibility).',
    {
      adapter_id: z.string(),
      confirm: z.literal(true).describe('Required safety flag — must be true'),
    },
    async ({ adapter_id, confirm }) => {
      if (confirm !== true) {
        return { content: [{ type: 'text' as const, text: 'Refused — `confirm: true` is required.' }] };
      }
      const { trainingCancel } = await import('./training/index.js');
      const entry = await trainingCancel(adapter_id);
      if (!entry) {
        return { content: [{ type: 'text' as const, text: `Adapter ${adapter_id} not found.` }] };
      }
      return { content: [{ type: 'text' as const, text: `Cancelled ${adapter_id}. Memories from manifest v${entry.manifestVersion} returned to default RAG visibility.` }] };
    },
  );

  // --- Eval + promotion ---
  server.tool(
    'eval_run',
    'Run aggregate eval on a trained adapter against the holdout slice of its training manifest. Returns an average 0-1 score and per-item detail. Incurs inference cost.',
    {
      adapter_id: z.string(),
    },
    async ({ adapter_id }) => {
      try {
        const { getAdapter } = await import('./training/registry.js');
        const entry = getAdapter(adapter_id);
        if (!entry) return { content: [{ type: 'text' as const, text: `Adapter ${adapter_id} not in registry.` }] };
        if (!entry.outputModelRef) {
          return { content: [{ type: 'text' as const, text: `Adapter ${adapter_id} has no outputModelRef yet. Poll training_get first.` }] };
        }
        const { evalRun } = await import('./training/eval.js');
        const result = await evalRun({ adapterRef: entry.outputModelRef, manifestVersion: entry.manifestVersion });
        const { updateAdapter } = await import('./training/registry.js');
        updateAdapter(adapter_id, { evalScore: result.averageScore });
        const lines = [
          `Eval for ${adapter_id}:`,
          `  items: ${result.itemCount}`,
          `  average score: ${result.averageScore.toFixed(3)}`,
          '',
          ...result.items.slice(0, 10).map(i =>
            `  - ${i.memoryId}: score=${i.score.toFixed(2)} winner=${i.winner} — ${i.rationale}`),
        ];
        if (result.items.length > 10) lines.push(`  ...and ${result.items.length - 10} more`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Eval error: ${e}` }] };
      }
    },
  );

  server.tool(
    'eval_compare',
    'Side-by-side eval comparison of two adapters on the same holdout. Use to decide whether a new adapter beats the incumbent before promoting.',
    {
      adapter_id_a: z.string(),
      adapter_id_b: z.string(),
    },
    async ({ adapter_id_a, adapter_id_b }) => {
      try {
        const { getAdapter } = await import('./training/registry.js');
        const a = getAdapter(adapter_id_a);
        const b = getAdapter(adapter_id_b);
        if (!a || !b) return { content: [{ type: 'text' as const, text: 'Both adapters must exist in the registry.' }] };
        if (a.manifestVersion !== b.manifestVersion) {
          return { content: [{ type: 'text' as const, text: `Refusing — adapters trained on different manifests (v${a.manifestVersion} vs v${b.manifestVersion}).` }] };
        }
        if (!a.outputModelRef || !b.outputModelRef) {
          return { content: [{ type: 'text' as const, text: 'Both adapters must have outputModelRef. Poll training_get.' }] };
        }
        const { evalCompare } = await import('./training/eval.js');
        const result = await evalCompare(a.outputModelRef, b.outputModelRef, a.manifestVersion);
        const lines = [
          `${adapter_id_a}: avg ${result.adapterA.averageScore.toFixed(3)}`,
          `${adapter_id_b}: avg ${result.adapterB.averageScore.toFixed(3)}`,
          `delta (B-A): ${result.delta.toFixed(3)}`,
          `winner: ${result.winner}`,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Compare error: ${e}` }] };
      }
    },
  );

  server.tool(
    'eval_verify',
    'Per-memory verification: for every memory in the adapter\'s training manifest, query the adapter and judge whether the answer covers the memory. Writes verification_last_result back onto each memory. Requires YAPA_VERIFICATION_ENABLED=true (acknowledges inference cost).',
    {
      adapter_id: z.string(),
    },
    async ({ adapter_id }) => {
      try {
        const { getAdapter } = await import('./training/registry.js');
        const entry = getAdapter(adapter_id);
        if (!entry) return { content: [{ type: 'text' as const, text: `Adapter ${adapter_id} not in registry.` }] };
        if (!entry.outputModelRef) {
          return { content: [{ type: 'text' as const, text: `Adapter has no outputModelRef yet.` }] };
        }
        const { verifyAdapterAgainstManifest } = await import('./training/verification.js');
        const result = await verifyAdapterAgainstManifest(entry.outputModelRef, entry.manifestVersion);
        const lines = [
          `Verification for ${adapter_id}:`,
          `  passed: ${result.passedCount}`,
          `  failed: ${result.failedCount}`,
          '',
          ...result.items.slice(0, 15).map(i =>
            `  - ${i.memoryId}: ${i.passed ? 'PASS' : 'FAIL'} (conf ${i.confidence.toFixed(2)}) — ${i.rationale}`),
        ];
        if (result.items.length > 15) lines.push(`  ...and ${result.items.length - 15} more`);
        lines.push('', 'Next: call adapter_promote to move verified memories out of default RAG.');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Verify error: ${e}` }] };
      }
    },
  );

  server.tool(
    'adapter_promote',
    'Promote a trained adapter: transition verified memories from selected_for → promoted_to. Memories that failed verification have their selected_for cleared and return to default RAG. Requires the adapter to be in `completed` status and verification to have been run.',
    {
      adapter_id: z.string(),
      confirm: z.literal(true),
    },
    async ({ adapter_id, confirm }) => {
      if (confirm !== true) {
        return { content: [{ type: 'text' as const, text: 'Refused — confirm must be true.' }] };
      }
      try {
        const { adapterPromote } = await import('./training/promotion.js');
        const result = await adapterPromote({ adapterId: adapter_id, confirm: true });
        const lines = [
          `Promoted adapter ${result.adapterId} (manifest v${result.manifestVersion}).`,
          `  Memories promoted (hidden from default RAG): ${result.promoted}`,
          `  Memories rolled back (failed verification, back in RAG): ${result.rolledBackSelections}`,
        ];
        if (result.outputModelRef) lines.push(`  Adapter ref: ${result.outputModelRef}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Promote error: ${e}` }] };
      }
    },
  );

  server.tool(
    'adapter_demote',
    'Rollback an adapter promotion. Clears promoted_to for every memory associated with the adapter\'s manifest. Restores full RAG visibility.',
    {
      adapter_id: z.string(),
      confirm: z.literal(true),
    },
    async ({ adapter_id, confirm }) => {
      if (confirm !== true) {
        return { content: [{ type: 'text' as const, text: 'Refused — confirm must be true.' }] };
      }
      try {
        const { adapterDemote } = await import('./training/promotion.js');
        const result = await adapterDemote(adapter_id);
        return { content: [{ type: 'text' as const, text: `Demoted ${result.adapterId}. ${result.rolledBack} memory(ies) returned to default RAG.` }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Demote error: ${e}` }] };
      }
    },
  );

  // --- Tasks ---
  server.tool(
    'task_create',
    'Create a task with title, priority, due date, tags, and collection',
    {
      title: z.string().describe('Task title'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Priority level (default: medium)'),
      due: z.string().optional().describe('Due date: "today", "tomorrow", "next Monday", "in 3 days", "May 27"'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      notes: z.string().optional().describe('Additional notes'),
      customer: z.string().optional().describe('Customer name'),
      project: z.string().optional().describe('Project name'),
      collection: z.string().optional().describe('Collection (default: global)'),
      is_recurring: z.boolean().optional().describe('Whether task recurs'),
      recurrence_pattern: z.enum(['daily', 'weekly', 'monthly']).optional().describe('Recurrence pattern'),
    },
    async ({ title, priority, due, tags, notes, customer, project, collection, is_recurring, recurrence_pattern }) => {
      const due_date = due ? parseRelativeDate(due) ?? undefined : undefined;
      const id = await createTask(title, {
        priority, due_date, tags, notes, customer, project, is_recurring, recurrence_pattern,
      }, collection ?? 'global');

      let text = `Created task ${id}: "${title}"`;
      if (due_date) text += ` (due: ${formatTaskDate(due_date)})`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'task_list',
    'List tasks with optional filters (status, priority, collection, due)',
    {
      status: z.enum(['pending', 'in_progress', 'blocked', 'complete']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      customer: z.string().optional(),
      project: z.string().optional(),
      collection: z.string().optional(),
      include_complete: z.boolean().optional().describe('Include completed tasks (default: false)'),
    },
    async ({ status, priority, customer, project, collection, include_complete }) => {
      const tasks = await listTasks({
        status, priority, customer, project, collection,
        includeComplete: include_complete,
      });
      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No tasks found.' }] };
      }
      const text = tasks.map(t => {
        let line = `- **${t.id}** [${t.metadata.status}] ${t.metadata.priority} | ${t.title}`;
        if (t.metadata.due_date) line += ` (due: ${formatTaskDate(t.metadata.due_date)})`;
        line += ` [${t.collection}]`;
        return line;
      }).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'task_get',
    'Get a single task by ID',
    {
      id: z.string().describe('Task ID (e.g., user-1)'),
    },
    async ({ id }) => {
      const task = await getTask(id);
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Task ${id} not found.` }] };
      }
      const lines = [
        `**${task.id}**: ${task.title}`,
        `Status: ${task.metadata.status} | Priority: ${task.metadata.priority}`,
        `Collection: ${task.collection}`,
      ];
      if (task.metadata.due_date) lines.push(`Due: ${formatTaskDate(task.metadata.due_date)}`);
      if (task.metadata.notes) lines.push(`Notes: ${task.metadata.notes}`);
      if (task.metadata.tags) {
        const tags = Array.isArray(task.metadata.tags) ? task.metadata.tags : (task.metadata.tags ?? '').split(',').filter(Boolean);
        if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
      }
      const deps = Array.isArray(task.metadata.depends_on) ? task.metadata.depends_on : (task.metadata.depends_on ?? '').split(',').filter(Boolean);
      if (deps.length) lines.push(`Depends on: ${deps.join(', ')}`);
      const blocks = Array.isArray(task.metadata.blocks) ? task.metadata.blocks : (task.metadata.blocks ?? '').split(',').filter(Boolean);
      if (blocks.length) lines.push(`Blocks: ${blocks.join(', ')}`);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'task_update',
    'Update task fields (status, priority, notes, due, tags)',
    {
      id: z.string().describe('Task ID'),
      status: z.enum(['pending', 'in_progress', 'blocked', 'complete']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      notes: z.string().optional(),
      due: z.string().optional().describe('Due date phrase'),
      tags: z.array(z.string()).optional(),
      blocked_reason: z.string().optional(),
    },
    async ({ id, status, priority, notes, due, tags, blocked_reason }) => {
      const updates: Record<string, any> = {};
      if (status) updates.status = status;
      if (priority) updates.priority = priority;
      if (notes !== undefined) updates.notes = notes;
      if (tags) updates.tags = tags;
      if (blocked_reason) updates.blockedReason = blocked_reason;
      if (due) {
        const ts = parseRelativeDate(due);
        if (ts) updates.due_date = ts;
      }

      await updateTask(id, updates);
      return { content: [{ type: 'text' as const, text: `Updated task ${id}` }] };
    },
  );

  server.tool(
    'task_complete',
    'Mark a task as done. Handles recurring task regeneration.',
    {
      id: z.string().describe('Task ID to complete'),
    },
    async ({ id }) => {
      const result = await completeTask(id);
      let text = `Completed task ${id}`;
      if (result.regeneratedId) {
        text += ` → regenerated as ${result.regeneratedId} (recurring)`;
      }
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'task_delete',
    'Remove a task permanently',
    {
      id: z.string().describe('Task ID to delete'),
    },
    async ({ id }) => {
      const collection = await deleteTask(id);
      return {
        content: [{ type: 'text' as const, text: `Deleted task ${id} from collection "${collection}"` }],
      };
    },
  );

  server.tool(
    'task_search',
    'Semantic search across tasks',
    {
      query: z.string().describe('Search query'),
      customer: z.string().optional(),
      project: z.string().optional(),
      collection: z.string().optional(),
    },
    async ({ query, customer, project, collection }) => {
      const results = await searchTasks(query, { customer, project, collection });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching tasks found.' }] };
      }
      const text = results.map(r =>
        `- **${r.id}** [${r.metadata.status}] ${r.title} (similarity: ${r.similarity.toFixed(3)}) [${r.collection}]`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'task_add_dependency',
    'Add a depends-on/blocks relationship between tasks',
    {
      task_id: z.string().describe('Task that depends on another'),
      depends_on_id: z.string().describe('Task that must complete first'),
    },
    async ({ task_id, depends_on_id }) => {
      await addDependency(task_id, depends_on_id);
      return {
        content: [{ type: 'text' as const, text: `${task_id} now depends on ${depends_on_id}` }],
      };
    },
  );

  // --- Collections ---
  server.tool(
    'collection_list',
    'List all collections with document counts',
    {},
    async () => {
      const collections = await listCollectionsWithCounts();
      if (collections.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No collections found.' }] };
      }
      const text = collections.map(c =>
        `- **${c.name}**: ${c.documentCount} documents`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'collection_create',
    'Create a new collection',
    {
      name: z.string().describe('Collection name (e.g., customer-acme, project-api)'),
    },
    async ({ name }) => {
      await createNewCollection(name);
      return { content: [{ type: 'text' as const, text: `Created collection "${name}"` }] };
    },
  );

  server.tool(
    'collection_delete',
    'Delete a collection and all its contents',
    {
      name: z.string().describe('Collection name to delete'),
    },
    async ({ name }) => {
      await removeCollection(name);
      return { content: [{ type: 'text' as const, text: `Deleted collection "${name}"` }] };
    },
  );

  // --- Sync ---
  server.tool(
    'sync_status',
    'Check remote sync status — connection health, last sync times, pending items',
    {},
    async () => {
      const { SYNC_ENABLED, SYNC_DATABASE_URL, SYNC_INTERVAL_MS } = await import('./config.js');
      if (!SYNC_ENABLED) {
        return { content: [{ type: 'text' as const, text: 'Remote sync is disabled. Set YAPA_SYNC_ENABLED=true to enable.' }] };
      }
      const lines = [`Sync: **enabled** (interval: ${SYNC_INTERVAL_MS / 1000}s)`];
      lines.push(`Remote: ${SYNC_DATABASE_URL ? SYNC_DATABASE_URL.replace(/:[^:@]*@/, ':***@') : 'not configured'}`);

      try {
        const { checkRemoteHealth } = await import('./sync/postgres.js');
        const health = await checkRemoteHealth();
        lines.push(`Connection: ${health.ok ? 'healthy' : `error — ${health.error}`}`);
      } catch (e) {
        lines.push(`Connection: error — ${e}`);
      }

      try {
        const { getSyncPullTimestamp } = await import('./sync/sentinel.js');
        const lastPull = await getSyncPullTimestamp();
        lines.push(`Last pull: ${lastPull ? new Date(lastPull * 1000).toISOString() : 'never'}`);
      } catch {
        lines.push('Last pull: unknown');
      }

      try {
        const { getPendingDeletes } = await import('./sync/deletes.js');
        const pending = await getPendingDeletes();
        if (pending.length > 0) lines.push(`Pending deletes: ${pending.length}`);
      } catch {
        // ignore
      }

      // Background sync state (in-memory)
      try {
        const { getSyncState } = await import('./sync/index.js');
        const state = getSyncState();
        lines.push(`Background timer: ${state.timerActive ? 'active' : 'inactive'}`);
        lines.push(`Cycles completed: ${state.cycleCount}`);
        if (state.lastCycleAt) {
          lines.push(`Last cycle: ${new Date(state.lastCycleAt).toISOString()}`);
        }
        if (state.lastCycleError) {
          lines.push(`Last error: ${state.lastCycleError}`);
        }
      } catch {
        lines.push('Background state: unavailable');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'sync_now',
    'Trigger an immediate sync cycle (push then pull)',
    {},
    async () => {
      const { SYNC_ENABLED } = await import('./config.js');
      if (!SYNC_ENABLED) {
        return { content: [{ type: 'text' as const, text: 'Remote sync is disabled.' }] };
      }
      try {
        const { syncCycle } = await import('./sync/index.js');
        const stats = await syncCycle();
        if (!stats) {
          return { content: [{ type: 'text' as const, text: 'Sync skipped — previous cycle still running.' }] };
        }
        const { push, pull } = stats;
        const summary = `Sync cycle completed. Push: ${push.pushed} new, ${push.linked} linked, ${push.deleted} deleted, ${push.errors} errors | Pull: ${pull.pulled} new, ${pull.linked} linked, ${pull.skipped} skipped, ${pull.errors} errors`;
        return { content: [{ type: 'text' as const, text: summary }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Sync error: ${e}` }] };
      }
    },
  );

  server.tool(
    'sync_remote_collections',
    'List collections available on the remote database with subscription status',
    {},
    async () => {
      const { SYNC_ENABLED } = await import('./config.js');
      if (!SYNC_ENABLED) {
        return { content: [{ type: 'text' as const, text: 'Remote sync is disabled.' }] };
      }
      try {
        const { getRemoteCollections } = await import('./sync/postgres.js');
        const { getSyncSubscriptions } = await import('./sync/sentinel.js');
        const [remote, subscriptions] = await Promise.all([getRemoteCollections(), getSyncSubscriptions()]);
        const subSet = new Set(subscriptions);

        if (remote.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No collections found on remote.' }] };
        }

        const lines = remote.map(r =>
          `- **${r.name}**: ${r.count} docs ${subSet.has(r.name) ? '(subscribed)' : ''}`
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error querying remote: ${e}` }] };
      }
    },
  );

  server.tool(
    'sync_subscribe',
    'Subscribe to remote collections for pull sync',
    {
      collections: z.array(z.string()).describe('Collection names to subscribe to'),
    },
    async ({ collections: requested }) => {
      const { SYNC_ENABLED } = await import('./config.js');
      if (!SYNC_ENABLED) {
        return { content: [{ type: 'text' as const, text: 'Remote sync is disabled.' }] };
      }
      try {
        const { getRemoteCollections } = await import('./sync/postgres.js');
        const { getSyncSubscriptions, updateSyncSubscriptions } = await import('./sync/sentinel.js');
        const { getOrCreateCollection } = await import('./chroma.js');

        // Validate that requested collections exist on remote
        const remote = await getRemoteCollections();
        const remoteNames = new Set(remote.map(r => r.name));
        const valid: string[] = [];
        const invalid: string[] = [];
        for (const name of requested) {
          if (remoteNames.has(name)) valid.push(name);
          else invalid.push(name);
        }

        if (valid.length === 0) {
          return { content: [{ type: 'text' as const, text: `None of the requested collections exist on remote. Available: ${[...remoteNames].join(', ')}` }] };
        }

        // Add to subscriptions (deduped)
        const existing = await getSyncSubscriptions();
        const merged = [...new Set([...existing, ...valid])];
        await updateSyncSubscriptions(merged);

        // Create local collections for any that don't exist yet
        for (const name of valid) {
          await getOrCreateCollection(name);
        }

        // Trigger a sync cycle
        const { syncCycle } = await import('./sync/index.js');
        await syncCycle();

        const lines = [`Subscribed to: ${valid.join(', ')}`];
        if (invalid.length > 0) {
          lines.push(`Not found on remote: ${invalid.join(', ')}`);
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
      }
    },
  );

  server.tool(
    'sync_unsubscribe',
    'Unsubscribe from remote collections (local data is kept)',
    {
      collections: z.array(z.string()).describe('Collection names to unsubscribe from'),
    },
    async ({ collections: toRemove }) => {
      const { SYNC_ENABLED } = await import('./config.js');
      if (!SYNC_ENABLED) {
        return { content: [{ type: 'text' as const, text: 'Remote sync is disabled.' }] };
      }
      try {
        const { getSyncSubscriptions, updateSyncSubscriptions } = await import('./sync/sentinel.js');
        const existing = await getSyncSubscriptions();
        const removeSet = new Set(toRemove);
        const updated = existing.filter(c => !removeSet.has(c));
        await updateSyncSubscriptions(updated);

        const removed = toRemove.filter(c => existing.includes(c));
        const notFound = toRemove.filter(c => !existing.includes(c));

        const lines: string[] = [];
        if (removed.length > 0) lines.push(`Unsubscribed from: ${removed.join(', ')}`);
        if (notFound.length > 0) lines.push(`Not subscribed: ${notFound.join(', ')}`);
        lines.push('Local data has been kept.');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${e}` }] };
      }
    },
  );

  // --- Maintenance ---
  server.tool(
    'decay_sweep',
    'Manually trigger salience decay across all memories',
    {},
    async () => {
      const count = await runDecaySweep();
      return {
        content: [{ type: 'text' as const, text: `Decay sweep complete. ${count} documents updated.` }],
      };
    },
  );

  // --- Uninstall ---
  server.tool(
    'uninstall',
    'Uninstall YAPA. Returns steps for the agent to execute.',
    {
      delete_collections: z.boolean().optional().describe('Also delete all ChromaDB collections? Default: false (preserve data)'),
    },
    async ({ delete_collections }) => {
      const repoDir = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
      let step = 1;
      const steps: string[] = [
        'Execute these steps now to uninstall YAPA. Do not summarize — run them.',
        '',
        `${step++}. Remove the YAPA MCP server registration:`,
        '   - Claude Code: run `claude mcp remove yapa`',
        '   - Cursor: remove the `"yapa"` entry from `~/.cursor/mcp.json`',
        '   - OpenCode: remove the `"yapa"` entry from `.opencode/config.json`',
        '',
        `${step++}. Remove the \`## YAPA — Memory & Task Assistant\` block (and everything below it until the next \`##\` heading or end of file) from ALL of these files. Check each one and remove the block if present:`,
        '   - `./CLAUDE.md` (current project)',
        '   - `./AGENTS.md` (current project)',
        '   - `~/.claude/CLAUDE.md` (global)',
        '   - `~/.config/opencode/AGENTS.md` (global)',
        '',
        `${step++}. Clean up the YAPA repo build artifacts: \`rm -rf ${repoDir}/dist ${repoDir}/node_modules\``,
      ];

      if (delete_collections) {
        steps.push(
          '',
          `${step++}. Delete all YAPA collections from ChromaDB:`,
          '   Run `collection_list` to see all collections, then run `collection_delete` for each one.',
        );
      }

      steps.push(
        '',
        `${step++}. Tell the user to restart their editor to complete removal.`,
      );

      if (!delete_collections) {
        steps.push(
          '',
          'Note: ChromaDB collections (memories and tasks) have been preserved. To also delete them, run `uninstall` again with `delete_collections: true`.',
        );
      }

      return {
        content: [{ type: 'text' as const, text: steps.join('\n') }],
      };
    },
  );
}
