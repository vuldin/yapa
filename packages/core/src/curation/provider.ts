import { getConfig, getCurationModel } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequestOptions {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  /** Request JSON output where the provider supports it (OpenAI-compatible only). */
  json_mode?: boolean;
}

/**
 * Call the configured curation LLM and return raw text content.
 * Follows the same switch pattern as src/embeddings.ts.
 */
export async function callCurationLLM(options: LLMRequestOptions): Promise<string> {
  const model = getCurationModel();
  switch (getConfig().CURATION_LLM_PROVIDER) {
    case 'fireworks':
      return fetchOpenAICompatible(
        'https://api.fireworks.ai/inference/v1/chat/completions',
        getConfig().FIREWORKS_API_KEY,
        model,
        options,
      );
    case 'openai':
      return fetchOpenAICompatible(
        'https://api.openai.com/v1/chat/completions',
        getConfig().OPENAI_API_KEY,
        model,
        options,
      );
    case 'anthropic':
      return fetchAnthropic(getConfig().ANTHROPIC_API_KEY, model, options);
    case 'ollama':
      return fetchOllama(getConfig().OLLAMA_URL, model, options);
    default:
      throw new Error(`Unknown curation LLM provider: ${getConfig().CURATION_LLM_PROVIDER}`);
  }
}

async function fetchOpenAICompatible(
  url: string,
  apiKey: string,
  model: string,
  options: LLMRequestOptions,
): Promise<string> {
  if (!apiKey) throw new Error(`Missing API key for ${getConfig().CURATION_LLM_PROVIDER}`);
  const body: Record<string, any> = {
    model,
    messages: options.messages,
    temperature: options.temperature ?? 0,
    max_tokens: options.max_tokens ?? 4096,
  };
  if (options.json_mode) body.response_format = { type: 'json_object' };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${await response.text()}`);
  }

  const data: any = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`Unexpected LLM response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return content;
}

async function fetchAnthropic(
  apiKey: string,
  model: string,
  options: LLMRequestOptions,
): Promise<string> {
  if (!apiKey) throw new Error('Missing getConfig().ANTHROPIC_API_KEY for curation');

  // Anthropic separates the system prompt from the messages array.
  const systemMsgs = options.messages.filter(m => m.role === 'system').map(m => m.content);
  const chatMsgs = options.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: options.max_tokens ?? 4096,
      temperature: options.temperature ?? 0,
      system: systemMsgs.join('\n\n') || undefined,
      messages: chatMsgs,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data: any = await response.json();
  const block = data.content?.[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error(`Unexpected Anthropic response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return block.text;
}

async function fetchOllama(
  ollamaUrl: string,
  model: string,
  options: LLMRequestOptions,
): Promise<string> {
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: options.messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0,
        num_predict: options.max_tokens ?? 4096,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${await response.text()}`);
  }

  const data: any = await response.json();
  if (typeof data.message?.content !== 'string') {
    throw new Error(`Unexpected Ollama response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.message.content;
}
