/**
 * The YAPA version running. The plugin bundle gets it at build time
 * (scripts/build-plugin.mjs defines __YAPA_VERSION__); the `claude mcp add`
 * build reads this package's package.json.
 */
import { readFileSync } from 'node:fs';

declare const __YAPA_VERSION__: string | undefined;

function fromPackage(): string {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export const YAPA_VERSION: string = typeof __YAPA_VERSION__ === 'string' ? __YAPA_VERSION__ : fromPackage();
