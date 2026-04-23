import { artifactPath } from '../buckets/artifacts.js';
import { getDocumentsByFilter, listCollections, updateDocument } from '../chroma.js';
import { VERIFICATION_ATTEMPTS_MAX, VERIFICATION_ENABLED } from '../config.js';
import { defaultInferenceCaller, type InferenceCaller } from './inference.js';
import { judgeVerification, type JudgeCaller } from './judge.js';
import { readManifestSource, synthesizeMemory } from './synthesis.js';

const MAX_PER_COLLECTION = 2000;

export interface VerifyItemResult {
  memoryId: string;
  collection: string | null;
  passed: boolean;
  confidence: number;
  rationale: string;
  userPrompt: string;
  candidateAnswer: string;
}

export interface VerifyResult {
  adapterRef: string;
  manifestVersion: number;
  passedCount: number;
  failedCount: number;
  items: VerifyItemResult[];
}

async function findDocByManifestId(manifestId: string): Promise<{ collection: string; metadata: Record<string, any> } | null> {
  const collections = await listCollections();
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter(c.name, { type: 'memory' }, MAX_PER_COLLECTION);
      const match = docs.find(d => d.id === manifestId);
      if (match) return { collection: c.name, metadata: match.metadata };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * For every memory in the given training manifest, synthesize a question whose
 * answer requires the memory's content, query the adapter, and judge whether
 * the adapter's answer covers the memory. Updates metadata with
 * verification_attempts and verification_last_result on each memory.
 *
 * Requires YAPA_VERIFICATION_ENABLED=true to acknowledge the cost of inference.
 */
export async function verifyAdapterAgainstManifest(
  adapterRef: string,
  manifestVersion: number,
  options: { inferenceCall?: InferenceCaller; judgeCall?: JudgeCaller; bypassEnabledGate?: boolean } = {},
): Promise<VerifyResult> {
  if (!VERIFICATION_ENABLED && !options.bypassEnabledGate) {
    throw new Error(
      'YAPA_VERIFICATION_ENABLED is false. Verification requires inference calls that may incur cost. Set the env var to true to opt in.',
    );
  }

  const inference = options.inferenceCall ?? defaultInferenceCaller;
  const manifestPath = artifactPath('training-manifests', `v${manifestVersion}.jsonl`);
  const memories = readManifestSource(manifestPath);

  const items: VerifyItemResult[] = [];
  for (const mem of memories) {
    const item: VerifyItemResult = {
      memoryId: mem.id,
      collection: null,
      passed: false,
      confidence: 0,
      rationale: '',
      userPrompt: '',
      candidateAnswer: '',
    };

    try {
      const syn = await synthesizeMemory(mem);
      const example = syn.examples[0];
      if (!example) {
        item.rationale = 'synthesis returned no examples';
        items.push(item);
        continue;
      }
      const userTurn = example.messages.find(m => m.role === 'user');
      if (!userTurn) {
        item.rationale = 'synthesis example had no user turn';
        items.push(item);
        continue;
      }
      item.userPrompt = userTurn.content;

      item.candidateAnswer = await inference({
        model: adapterRef,
        messages: example.messages.filter(m => m.role !== 'assistant'),
        temperature: 0,
        max_tokens: 1024,
      });

      const judgment = await judgeVerification(
        mem.content,
        item.candidateAnswer,
        item.userPrompt,
        { call: options.judgeCall },
      );
      item.passed = judgment.passed;
      item.confidence = judgment.confidence;
      item.rationale = judgment.rationale;
    } catch (e) {
      item.rationale = `error: ${e}`;
    }

    // Record on the underlying memory metadata
    const found = await findDocByManifestId(mem.id);
    if (found) {
      item.collection = found.collection;
      const attempts = Number(found.metadata.verification_attempts ?? 0) + 1;
      const updated = {
        ...found.metadata,
        verification_attempts: attempts,
        verification_last_result: item.passed ? 'passed' : 'failed',
      };
      try {
        await updateDocument(found.collection, mem.id, updated);
      } catch (e) {
        process.stderr.write(`[yapa-verify] Metadata update failed for ${mem.id}: ${e}\n`);
      }
    }

    items.push(item);
  }

  const passedCount = items.filter(i => i.passed).length;
  const failedCount = items.length - passedCount;

  return { adapterRef, manifestVersion, passedCount, failedCount, items };
}

export { VERIFICATION_ATTEMPTS_MAX };
