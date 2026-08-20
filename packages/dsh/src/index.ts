/**
 * YAPA — Memory & Task assistant as a native DeepSeek Harness plugin.
 *
 * Namespace plugin (named exports, no default export), matching the cordis
 * loader contract: `name` + `inject` + `Config` + `apply`. Lifecycle is
 * effect-scoped: disposal unregisters every tool, the prompt sections, the
 * pre-step injector, the settings namespace, skills, and background timers.
 *
 * Install (see packages/dsh/install.md):
 *   dsh plugin --profile web add <path-or-spec>
 *   # then insert into the profile's cordis.patch.yml:
 *   - insert:
 *       - id: yapa
 *         name: 'yapa'
 *         config: { username: you }
 *
 * @module yapa
 */
import type { Context } from '@deepseek-ai/cordis';
// Pull the cordis Context augmentations for the services this plugin uses.
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-skill';
import { setConfig, setStore, chromaStore, createLocalStore, type YapaConfig } from '@yapa/core';
import { Config, resolveConfig, type ResolvedConfig } from './config.js';
import { registerTools } from './tools.js';
import { registerAdvancedTools } from './tools-advanced.js';
import { registerInjector } from './injector.js';
import { registerLifecycle } from './lifecycle.js';
import { installLlmBridge } from './llm-bridge.js';
import { registerPromotedSection } from './promoted-section.js';
import { registerSkills } from './skills.js';
import { registerScheduleBridge } from './schedule-bridge.js';
import { registerCompactionCapture } from './compaction-capture.js';
import { RULES_SECTION_NAME, RULES_SECTION_ORDER, RULES_TEXT } from './rules.js';

export { Config } from './config.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'yapa';

/** Services required by this plugin (all composed by dsh-base). */
export const inject = ['tools', 'systemPrompt', 'settings', 'sessions', 'timer', 'llm', 'skills'];

/** Strip undefined values so a settings layer never clobbers with `undefined`. */
function definedOnly(c: Config): Partial<Config> {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as Partial<Config>;
}

export function apply(ctx: Context, config: Config): void {
  // --- Config resolution: env → cordis row → hot-reloaded settings layer ----
  let currentConfig: Config = { ...config };
  let resolved: ResolvedConfig = resolveConfig(currentConfig);
  setConfig(resolved.core);
  const getResolved = () => resolved;
  const getConfigValues = () => currentConfig;

  // --- Storage backend (ChromaDB server or embedded local store) -------------
  const applyStore = (core: YapaConfig) => {
    setStore(core.STORAGE === 'local' ? createLocalStore(core.LOCAL_STORE_PATH) : chromaStore);
  };
  applyStore(resolved.core);

  // --- Model-facing surface ---------------------------------------------------
  registerTools(ctx);
  registerAdvancedTools(ctx);
  ctx.systemPrompt.section({
    name: RULES_SECTION_NAME,
    order: RULES_SECTION_ORDER,
    text: RULES_TEXT,
  });
  registerPromotedSection(ctx, getResolved);
  registerSkills(ctx, getResolved);

  // --- Harness integrations ---------------------------------------------------
  installLlmBridge(ctx, getConfigValues);
  registerScheduleBridge(ctx, getResolved);
  registerCompactionCapture(ctx, getResolved);

  // --- Always-on context injection + session lifecycle + timers ---------------
  registerInjector(ctx, getResolved);
  const lifecycle = registerLifecycle(ctx, getResolved);

  // User overrides live in $DSH_HOME/settings.yaml under the `yapa:` section,
  // hot-reloaded; the cordis row config becomes the composition `base` layer.
  const scope = ctx.settings.register(settingsNamespace('yapa'), Config, { base: config, applies: 'live' });
  scope.watch(next => {
    const prevSync = resolved.core.SYNC_ENABLED && resolved.core.SYNC_DATABASE_URL;
    const prevInterval = resolved.core.SYNC_INTERVAL_MS;
    const prevStore = `${resolved.core.STORAGE}:${resolved.core.LOCAL_STORE_PATH}`;
    currentConfig = { ...config, ...definedOnly(next as Config) };
    resolved = resolveConfig(currentConfig);
    setConfig(resolved.core);
    if (prevStore !== `${resolved.core.STORAGE}:${resolved.core.LOCAL_STORE_PATH}`) {
      applyStore(resolved.core);
    }
    const nextSync = resolved.core.SYNC_ENABLED && resolved.core.SYNC_DATABASE_URL;
    if (prevSync !== nextSync || prevInterval !== resolved.core.SYNC_INTERVAL_MS) {
      lifecycle.syncChanged();
    }
  });
}
