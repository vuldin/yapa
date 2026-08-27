import {
  callCurationLLM,
  type LLMRequestOptions,
} from '../curation/provider.js';

export type JudgeCaller = (opts: LLMRequestOptions) => Promise<string>;

export const AGGREGATE_JUDGE_SYSTEM_PROMPT = `You are an impartial grader for language model outputs. Given a REFERENCE answer (the ground-truth, derived from the user's curated memory) and a CANDIDATE answer (produced by a model), decide whether the CANDIDATE is at least as good as the REFERENCE on content, reasoning, and coverage.

Return valid JSON only, no commentary, no fences:

{"score": <0.0-1.0>, "winner": "candidate" | "reference" | "tie", "rationale": "<one short sentence>"}

Scoring:
- 1.0 = candidate clearly superior or strictly matches the reference
- 0.75 = candidate matches the reference's key claims, minor gaps
- 0.5 = partial coverage or mostly correct with notable gaps
- 0.25 = shallow or partially wrong
- 0.0 = wrong, contradictory, or empty

Do not invent information. Do not reward fluency over correctness.`;

export const VERIFY_JUDGE_SYSTEM_PROMPT = `You verify whether a model's ANSWER covers the key content of a REFERENCE memory well enough that the memory can safely be removed from retrieval (because the knowledge now lives in the model's weights).

Return valid JSON only:

{"passed": <true|false>, "confidence": <0.0-1.0>, "rationale": "<one short sentence>"}

Pass criteria — BOTH must hold:
- The ANSWER states the memory's key claims, reasoning, or guidance.
- The ANSWER is factually consistent with the memory (no contradictions, no invented details).

Partial coverage is a fail. Being correct on general principles but missing the specific content of the memory is a fail.`;

export interface AggregateJudgeResult {
  score: number;
  winner: 'candidate' | 'reference' | 'tie';
  rationale: string;
}

export async function judgeAggregate(
  reference: string,
  candidate: string,
  userPrompt: string,
  options: { call?: JudgeCaller } = {},
): Promise<AggregateJudgeResult> {
  const caller = options.call ?? callCurationLLM;
  const raw = await caller({
    messages: [
      { role: 'system', content: AGGREGATE_JUDGE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `QUESTION:\n${userPrompt}\n\nREFERENCE:\n${reference}\n\nCANDIDATE:\n${candidate}`,
      },
    ],
    temperature: 0,
    max_tokens: 512,
    json_mode: true,
  });
  return parseAggregateJudge(raw);
}

export function parseAggregateJudge(raw: string): AggregateJudgeResult {
  const parsed = extractObject(raw);
  const score = clamp01((parsed as any)?.score);
  const winnerRaw = String((parsed as any)?.winner ?? '').toLowerCase();
  const winner: AggregateJudgeResult['winner'] =
    winnerRaw === 'candidate' || winnerRaw === 'reference' || winnerRaw === 'tie'
      ? (winnerRaw as AggregateJudgeResult['winner'])
      : score > 0.5 ? 'candidate' : score < 0.5 ? 'reference' : 'tie';
  const rationale = typeof (parsed as any)?.rationale === 'string' ? (parsed as any).rationale : '';
  return { score, winner, rationale };
}

export interface VerifyJudgeResult {
  passed: boolean;
  confidence: number;
  rationale: string;
}

export async function judgeVerification(
  memoryContent: string,
  adapterAnswer: string,
  userPrompt: string,
  options: { call?: JudgeCaller } = {},
): Promise<VerifyJudgeResult> {
  const caller = options.call ?? callCurationLLM;
  const raw = await caller({
    messages: [
      { role: 'system', content: VERIFY_JUDGE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `QUESTION TO THE MODEL:\n${userPrompt}\n\nREFERENCE MEMORY:\n${memoryContent}\n\nMODEL ANSWER:\n${adapterAnswer}`,
      },
    ],
    temperature: 0,
    max_tokens: 400,
    json_mode: true,
  });
  return parseVerifyJudge(raw);
}

export function parseVerifyJudge(raw: string): VerifyJudgeResult {
  const parsed = extractObject(raw);
  const passed = (parsed as any)?.passed === true || String((parsed as any)?.passed).toLowerCase() === 'true';
  const confidence = clamp01((parsed as any)?.confidence);
  const rationale = typeof (parsed as any)?.rationale === 'string' ? (parsed as any).rationale : '';
  return { passed, confidence, rationale };
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function extractObject(raw: string): unknown {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch { /* fall through */ }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new Error(`Could not extract JSON object from judge response: ${raw.slice(0, 200)}`);
}
