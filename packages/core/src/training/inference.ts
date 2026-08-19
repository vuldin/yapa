
import { getConfig } from '../config.js';
import type { ChatMessage } from '../curation/provider.js';

export interface InferenceOptions {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  max_tokens?: number;
}

/** Default fetcher, pulled out so tests can inject a stub. */
export type InferenceCaller = (opts: InferenceOptions) => Promise<string>;

export const defaultInferenceCaller: InferenceCaller = async (opts) => {
  if (!getConfig().FIREWORKS_API_KEY) {
    throw new Error('YAPA_FIREWORKS_API_KEY not set — cannot call the adapter inference endpoint.');
  }
  const response = await fetch(`${getConfig().INFERENCE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getConfig().FIREWORKS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.max_tokens ?? 1024,
    }),
  });

  if (!response.ok) {
    throw new Error(`Adapter inference error: ${response.status} ${await response.text()}`);
  }

  const data: any = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`Unexpected inference response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return content;
};
