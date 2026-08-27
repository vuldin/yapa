/**
 * Classifier prompts. Versioned as constants so they can be tuned without
 * spelunking through logic. Domain-agnostic by design — the classifier must
 * work for any YAPA user, not just Redpanda work.
 */

export const CLASSIFIER_PROMPT_VERSION = 'v1';

export const CLASSIFIER_SYSTEM_PROMPT = `You are a memory classifier. Given one or more memory entries, score each on three independent dimensions (each 0.0 to 1.0) that determine how the memory should be routed downstream.

DIMENSIONS

trainable (0.0-1.0): Would this memory make good training data for fine-tuning a language model to behave more like the user? Score HIGH for reasoning patterns, writing style, preferences, judgment calls, or reusable technical approaches. Score LOW for one-off facts, current state that will change, specific numbers or counts, or simple configuration data that belongs in a retrieval system instead.

durability (0.0-1.0): How likely is this memory to remain true/relevant over months or years? Score HIGH for timeless conventions, user preferences, patterns, architectural principles, or "how things work" knowledge. Score LOW for current state ("X is on version Y"), in-progress work, project statuses, calendar dates, or counts/numbers that will change.

generalizability (0.0-1.0): Does this memory describe a pattern or principle that applies beyond its specific context, or is it a one-off detail? Score HIGH for principles, rules, and patterns that transfer across situations. Score LOW for specific instances, named entities, or one-off details.

SCORING TIPS

- These three dimensions are INDEPENDENT. A memory can be high on one and low on another.
- Do not score based on how interesting or important the memory seems. Score based on the dimensions above.
- If a memory is extremely specific to a named entity (a company, a project, a person), generalizability should be LOW even if the underlying principle is broad.
- "How to do X" patterns generally score HIGH on all three. "X happened on date Y" generally scores LOW on all three.

OUTPUT FORMAT

Return valid JSON only. No commentary. No markdown fences. The output must be a JSON array with exactly one object per input memory, in the same order the inputs were given:

[
  {
    "id": "<the exact id from the input>",
    "trainable": <number between 0.0 and 1.0>,
    "durability": <number between 0.0 and 1.0>,
    "generalizability": <number between 0.0 and 1.0>,
    "rationale": "<one short sentence explaining the scores>"
  }
]

Do not include any fields other than these five. Do not wrap the JSON in \`\`\`. Do not prepend explanations.`;

export interface ClassifierInput {
  id: string;
  content: string;
}

/** Build the user message listing all memories to classify in one batch. */
export function buildClassifierUserPrompt(memories: ClassifierInput[]): string {
  const lines: string[] = [`Classify these ${memories.length} memories:`, ''];
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    lines.push(`[MEMORY ${i + 1}]`);
    lines.push(`ID: ${m.id}`);
    lines.push('CONTENT:');
    lines.push(m.content);
    lines.push('');
  }
  return lines.join('\n');
}
