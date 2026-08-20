/**
 * Routes yapa's auxiliary LLM calls (curation classifier, training synthesis,
 * eval judge) through the harness's own model registry (`ctx.llm`): provider
 * routes, credentials, and retry policy all come from the deployment instead
 * of separate `YAPA_*_API_KEY` config.
 *
 * Route selection: plugin config `auxProvider`/`auxModel` → the harness's
 * `agent-default-model` settings value → a clear, actionable error.
 *
 * @module yapa-dsh/llm-bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Message } from '@deepseek-ai/dsh-llm';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { setHostLLMCaller, type LLMRequestOptions } from '@yapa/core';
import type { Config } from './config.js';

/** Read the deployment's default agent route from settings (defensive narrowing). */
function defaultRoute(ctx: Context): { provider?: string; model?: string } {
  try {
    const v = ctx.settings.get(settingsNamespace('agent-default-model')) as
      | { provider?: unknown; model?: unknown }
      | undefined;
    return {
      provider: typeof v?.provider === 'string' ? v.provider : undefined,
      model: typeof v?.model === 'string' ? v.model : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Install the core host-LLM caller backed by `ctx.llm`. The returned disposer
 * (effect-scoped) clears the override so HMR/reload never leaks a stale route.
 */
export function installLlmBridge(ctx: Context, getConfigValues: () => Config): void {
  setHostLLMCaller(async (options: LLMRequestOptions): Promise<string> => {
    const configured = getConfigValues();
    const route = {
      provider: configured.auxProvider ?? defaultRoute(ctx).provider,
      model: configured.auxModel ?? defaultRoute(ctx).model,
    };
    if (!route.provider || !route.model) {
      throw new Error(
        'YAPA auxiliary LLM has no route: set `auxProvider`/`auxModel` in the plugin '
        + 'config (or settings.yaml `yapa:` section), or configure the harness default model.',
      );
    }

    // System-role content rides the dedicated system slot; the conversation
    // carries user/assistant messages only (per the GenerateOptions contract).
    const systemParts: string[] = [];
    const messages: Message[] = [];
    for (const m of options.messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else if (m.role === 'user') {
        messages.push(createUserMessage({
          content: [{ type: 'text', text: m.content }],
          source: { kind: 'plugin', plugin: 'yapa' },
        }));
      } else {
        messages.push(createAssistantMessage({
          content: [{ type: 'text', text: m.content }],
          source: { provider: route.provider, model: route.model },
        }));
      }
    }

    let text = '';
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      ...(systemParts.length && { system: systemParts.join('\n\n') }),
      temperature: options.temperature ?? 0,
      maxTokens: options.max_tokens ?? 4096,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'finish' && !text) {
        throw new Error(`YAPA auxiliary LLM call finished without content (reason: ${chunk.reason})`);
      }
    }
    return text;
  });

  ctx.effect(() => () => setHostLLMCaller(undefined));
}
