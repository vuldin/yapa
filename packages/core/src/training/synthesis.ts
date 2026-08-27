import { readFileSync } from 'fs';
import { getSynthesisModel } from '../config.js';
import {
  callCurationLLM,
  type ChatMessage,
  type LLMRequestOptions,
} from '../curation/provider.js';

export const SYNTHESIS_PROMPT_VERSION = 'v1';

export const SYNTHESIS_SYSTEM_PROMPT = `You convert a single memory into one or more training examples for supervised fine-tuning.

GOAL

Produce examples that teach a language model the PATTERNS, STYLE, and REASONING in the memory — not point-in-time facts. Examples must be standalone: a reader with no access to the memory should still get a plausible answer from the user/system turn alone.

FORMAT

Return valid JSON only, no commentary. The output must be a JSON array of one to three training examples, each in OpenAI chat format:

[
  {
    "messages": [
      { "role": "system", "content": "<optional persona or task framing>" },
      { "role": "user", "content": "<question or prompt a realistic user might ask>" },
      { "role": "assistant", "content": "<ideal response grounded in the memory's content/reasoning>" }
    ]
  }
]

RULES

- Keep user prompts realistic — not "Summarize this memory" but rather the kind of question a user would naturally ask.
- Assistant responses must reflect the reasoning, style, and judgment in the memory. Do not copy the memory verbatim; transform it into a response.
- If the memory is purely a transient fact ("version X is running on Y"), return an empty array [] — such memories are not suitable for fine-tuning.
- Keep examples under 800 tokens total each.
- Do not wrap the JSON in \`\`\` fences.
- Do not include fields other than "messages" on each example.`;

export interface SynthesisInput {
  id: string;
  collection?: string;
  content: string;
}

export interface SynthesisExample {
  messages: ChatMessage[];
}

export interface SynthesisResult {
  id: string;
  examples: SynthesisExample[];
}

export interface SynthesisOptions {
  call?: (opts: LLMRequestOptions) => Promise<string>;
}

export async function synthesizeMemory(
  memory: SynthesisInput,
  options: SynthesisOptions = {},
): Promise<SynthesisResult> {
  const caller = options.call ?? callCurationLLM;
  const userPrompt = `[MEMORY]\nID: ${memory.id}${memory.collection ? `\nCOLLECTION: ${memory.collection}` : ''}\nCONTENT:\n${memory.content}`;

  const raw = await caller({
    messages: [
      { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
    json_mode: true,
  });

  const examples = parseSynthesisResponse(raw);
  return { id: memory.id, examples };
}

export function parseSynthesisResponse(raw: string): SynthesisExample[] {
  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Synthesis response not a JSON array: ${raw.slice(0, 200)}`);
  }

  const results: SynthesisExample[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const messages = (entry as any).messages;
    if (!Array.isArray(messages) || messages.length < 2) continue;
    const cleaned: ChatMessage[] = [];
    let valid = true;
    for (const m of messages) {
      if (!m || typeof m !== 'object') { valid = false; break; }
      const role = (m as any).role;
      const content = (m as any).content;
      if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string') {
        valid = false;
        break;
      }
      cleaned.push({ role, content });
    }
    if (!valid) continue;
    // Require at least one assistant turn (the target label for SFT).
    if (!cleaned.some(m => m.role === 'assistant')) continue;
    results.push({ messages: cleaned });
  }
  return results;
}

function extractJsonArray(raw: string): unknown {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch { /* fall through */ }
  }
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new Error(`Could not extract JSON array from synthesis response: ${raw.slice(0, 200)}`);
}

/** Read a training-manifest JSONL and return the source memories. */
export function readManifestSource(path: string): SynthesisInput[] {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  return lines.map(l => {
    const entry = JSON.parse(l);
    return { id: entry.id, collection: entry.collection, content: entry.content };
  });
}

export function formatTrainingJsonl(results: SynthesisResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    for (const ex of r.examples) {
      lines.push(JSON.stringify(ex));
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

export { getSynthesisModel };
