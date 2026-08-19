/**
 * YAPA — Memory & Task assistant as a native DeepSeek Harness plugin.
 *
 * Namespace plugin (named exports, no default export), matching the cordis
 * loader contract: `name` + `inject` + `Config` + `apply`. Lifecycle is
 * effect-scoped: disposal unregisters every tool, the rules section, the
 * assemble injector, the settings namespace, and background timers.
 *
 * Install (see packages/dsh/install.md):
 *   dsh plugin --profile web add <path-or-spec>
 *   # then insert into the profile's cordis.patch.yml:
 *   - insert:
 *       - id: yapa
 *         name: '@yapa/dsh-plugin'
 *         config: { username: you }
 *
 * @module @yapa/dsh-plugin
 */
import type { Context } from '@deepseek-ai/cordis';
// Pull the cordis Context augmentations for the services this plugin uses.
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tools';
import { setConfig } from '@yapa/core';
import { Config, resolveConfig, type ResolvedConfig } from './config.js';
import { registerTools } from './tools.js';
import { registerInjector } from './injector.js';
import { registerLifecycle } from './lifecycle.js';
import { RULES_SECTION_NAME, RULES_SECTION_ORDER, RULES_TEXT } from './rules.js';

export { Config } from './config.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'yapa';

/** Services required by this plugin (all composed by dsh-base). */
export const inject = ['tools', 'systemPrompt', 'settings', 'sessions', 'timer'];

export function apply(ctx: Context, config: Config): void {
  // --- Config resolution: env → cordis row → hot-reloaded settings layer ----
  let resolved: ResolvedConfig = resolveConfig(config);
  setConfig(resolved.core);
  const getResolved = () => resolved;

  // --- Model-facing surface ---------------------------------------------------
  registerTools(ctx);
  ctx.systemPrompt.section({
    name: RULES_SECTION_NAME,
    order: RULES_SECTION_ORDER,
    text: RULES_TEXT,
  });

  // --- Always-on context injection + session lifecycle + timers ---------------
  registerInjector(ctx, getResolved);
  const lifecycle = registerLifecycle(ctx, getResolved);

  // User overrides live in $DSH_HOME/settings.yaml under the `yapa:` section,
  // hot-reloaded; the cordis row config becomes the composition `base` layer.
  const scope = ctx.settings.register(settingsNamespace('yapa'), Config, { base: config, applies: 'live' });
  scope.watch(next => {
    const prevSync = resolved.core.SYNC_ENABLED && resolved.core.SYNC_DATABASE_URL;
    const prevInterval = resolved.core.SYNC_INTERVAL_MS;
    resolved = resolveConfig(config, next);
    setConfig(resolved.core);
    const nextSync = resolved.core.SYNC_ENABLED && resolved.core.SYNC_DATABASE_URL;
    if (prevSync !== nextSync || prevInterval !== resolved.core.SYNC_INTERVAL_MS) {
      lifecycle.syncChanged();
    }
  });
}
