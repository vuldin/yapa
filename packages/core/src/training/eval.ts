import { artifactPath } from '../buckets/artifacts.js';
import { defaultInferenceCaller, type InferenceCaller } from './inference.js';
import { judgeAggregate, type JudgeCaller } from './judge.js';
import { loadManifestSplit } from './holdout.js';
import { synthesizeMemory, type SynthesisResult } from './synthesis.js';
import type { SynthesisInput } from './synthesis.js';

export interface EvalRunInput {
  adapterRef: string;
  manifestVersion: number;
}

export interface EvalItemResult {
  memoryId: string;
  score: number;
  winner: 'candidate' | 'reference' | 'tie';
  rationale: string;
  userPrompt: string;
}

export interface EvalRunResult {
  adapterRef: string;
  manifestVersion: number;
  itemCount: number;
  averageScore: number;
  items: EvalItemResult[];
}

/**
 * Run aggregate eval: for each memory in the holdout slice of the manifest,
 * synthesize a representative question, call the adapter, and grade with
 * an LLM judge. Returns the averaged score (0-1) plus per-item detail.
 */
export async function evalRun(
  input: EvalRunInput,
  options: { inferenceCall?: InferenceCaller; judgeCall?: JudgeCaller } = {},
): Promise<EvalRunResult> {
  const inference = options.inferenceCall ?? defaultInferenceCaller;
  const manifestName = `v${input.manifestVersion}.jsonl`;
  const manifestPath = artifactPath('training-manifests', manifestName);
  const { holdout } = loadManifestSplit(manifestPath, input.manifestVersion);

  const items: EvalItemResult[] = [];
  for (const mem of holdout) {
    let userPrompt = '';
    let candidateAnswer = '';
    try {
      const syn = await synthesizeMemory(mem);
      const example = syn.examples[0];
      if (!example) continue;
      const userTurn = example.messages.find(m => m.role === 'user');
      const assistantTurn = example.messages.find(m => m.role === 'assistant');
      if (!userTurn || !assistantTurn) continue;
      userPrompt = userTurn.content;

      candidateAnswer = await inference({
        model: input.adapterRef,
        messages: [
          ...example.messages.filter(m => m.role !== 'assistant'),
        ],
        temperature: 0,
        max_tokens: 1024,
      });

      const result = await judgeAggregate(
        assistantTurn.content,
        candidateAnswer,
        userPrompt,
        { call: options.judgeCall },
      );
      items.push({
        memoryId: mem.id,
        score: result.score,
        winner: result.winner,
        rationale: result.rationale,
        userPrompt,
      });
    } catch (e) {
      items.push({
        memoryId: mem.id,
        score: 0,
        winner: 'reference',
        rationale: `error: ${e}`,
        userPrompt,
      });
    }
  }

  const averageScore = items.length > 0
    ? items.reduce((s, i) => s + i.score, 0) / items.length
    : 0;

  return {
    adapterRef: input.adapterRef,
    manifestVersion: input.manifestVersion,
    itemCount: items.length,
    averageScore,
    items,
  };
}

export interface EvalCompareResult {
  adapterA: EvalRunResult;
  adapterB: EvalRunResult;
  delta: number;
  winner: 'A' | 'B' | 'tie';
}

export async function evalCompare(
  adapterRefA: string,
  adapterRefB: string,
  manifestVersion: number,
  options: { inferenceCall?: InferenceCaller; judgeCall?: JudgeCaller } = {},
): Promise<EvalCompareResult> {
  const a = await evalRun({ adapterRef: adapterRefA, manifestVersion }, options);
  const b = await evalRun({ adapterRef: adapterRefB, manifestVersion }, options);
  const delta = b.averageScore - a.averageScore;
  const winner: EvalCompareResult['winner'] = delta > 0.01 ? 'B' : delta < -0.01 ? 'A' : 'tie';
  return { adapterA: a, adapterB: b, delta, winner };
}
