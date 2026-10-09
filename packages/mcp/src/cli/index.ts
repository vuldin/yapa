#!/usr/bin/env node

import { adoptHostEnv } from './env.js';

const USAGE =
  'Usage: yapa hook <session-start|user-prompt-submit|stop|post-compact|session-end>\n' +
  '         (reads Claude Code hook JSON from stdin)\n' +
  '       yapa hooks install [--settings <path>]    add YAPA hooks to Claude Code settings\n' +
  '       yapa hooks uninstall [--settings <path>]  remove them\n' +
  '       yapa hooks print                          show the hooks block without writing it\n';

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function runHook(name: string): Promise<void> {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};

  // Aux `claude -p` children (response capture) must not re-enter YAPA.
  if (process.env.YAPA_HOOK_CHILD) {
    process.stdout.write('{}');
    return;
  }

  // Resolve the same settings the MCP server runs with BEFORE core reads its
  // config (which happens lazily on first use, inside the hook handlers).
  adoptHostEnv(input.cwd);
  const hooks = await import('./hooks.js');
  switch (name) {
    case 'session-start':
      return hooks.sessionStart(input);
    case 'user-prompt-submit':
      return hooks.userPromptSubmit(input);
    case 'stop':
      return hooks.stop(input);
    case 'post-compact':
      return hooks.postCompact(input);
    case 'session-end':
      return hooks.sessionEnd(input);
    default:
      usage();
  }
}

async function runHooksCommand(action: string | undefined, args: string[]): Promise<void> {
  const { installHooks, uninstallHooks, mergeHooks, selfCommand } = await import('./install-hooks.js');
  const at = args.indexOf('--settings');
  const path = at >= 0 ? args[at + 1] : undefined;
  switch (action) {
    case 'install':
      process.stdout.write(`YAPA hooks installed in ${installHooks(path)}\n`);
      return;
    case 'uninstall':
      process.stdout.write(`YAPA hooks removed from ${uninstallHooks(path)}\n`);
      return;
    case 'print':
      process.stdout.write(JSON.stringify(mergeHooks({}, selfCommand()), null, 2) + '\n');
      return;
    default:
      usage();
  }
}

async function main(): Promise<void> {
  const [command, sub, ...rest] = process.argv.slice(2);
  if (command === 'hooks') {
    await runHooksCommand(sub, rest);
    return;
  }
  if (command !== 'hook' || !sub) usage();

  try {
    await runHook(sub);
    // An abandoned (timed-out) remote pull would otherwise keep the pg pool
    // and the hook process alive past Claude Code's hook budget.
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[yapa] hook ${sub} failed: ${e}\n`);
    process.stdout.write('{}');
    process.exit(0);
  }
}

main();
