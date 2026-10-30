#!/usr/bin/env node

import { adoptCliEnv, adoptHostEnv } from './env.js';

const USAGE =
  'Usage: yapa hook <session-start|user-prompt-submit|stop|post-compact|session-end>\n' +
  '         (reads Claude Code hook JSON from stdin)\n' +
  '       yapa hooks install [--settings <path>]    add YAPA hooks to Claude Code settings\n' +
  '       yapa hooks uninstall [--settings <path>]  remove them\n' +
  '       yapa hooks print                          show the hooks block without writing it\n' +
  '       yapa coord <command> [options]            leases and counters on the sync service (yapa coord help)\n';

const COORD_USAGE =
  'Usage: yapa coord acquire   --collection C --key K [--session S] [--scope a,b] [--ttl SECONDS] [--title T]\n' +
  '       yapa coord heartbeat [--collection C [--keys a,b]] [--session S]\n' +
  '       yapa coord release   --collection C --key K [--session S] [--outcome done|blocked|pending]\n' +
  '       yapa coord list      --collection C [--include-expired]\n' +
  '       yapa coord counter-next --collection C --name N [--floor N]\n' +
  '       yapa coord task-id   [--floor N]\n' +
  '--session defaults to $YAPA_SESSION, then the Claude Code session ($CLAUDE_CODE_SESSION_ID). Prints one JSON object on stdout (--text: a short summary).\n' +
  'Exit: 0 done, 3 refused (held or overlapping), 4 service unavailable (nothing shared: fall back locally),\n' +
  '      2 bad arguments, 1 other error.\n';

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

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function list(v: string | undefined): string[] | undefined {
  return v === undefined ? undefined : v.split(',').map(x => x.trim()).filter(Boolean);
}

function int(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

async function runCoord(sub: string | undefined, args: string[]): Promise<number> {
  if (!sub || sub === 'help' || args.includes('--help')) {
    process.stderr.write(COORD_USAGE);
    return sub ? 0 : 2;
  }
  adoptCliEnv(process.cwd());
  const coord = await import('../coord.js');
  const collection = flag(args, '--collection');
  const need = (v: string | undefined, name: string) => {
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  let r;
  try {
    const session = coord.currentSession(flag(args, '--session'));
    if (!session && ['acquire', 'heartbeat', 'release'].includes(sub)) {
      throw new Error('--session is required outside Claude Code (or set YAPA_SESSION)');
    }
    switch (sub) {
      case 'acquire':
        r = await coord.leaseAcquire({
          collection: need(collection, '--collection'), key: need(flag(args, '--key'), '--key'), session,
          scope: list(flag(args, '--scope')), ttlSeconds: int(flag(args, '--ttl'), '--ttl'), title: flag(args, '--title'),
        });
        break;
      case 'heartbeat':
        r = await coord.leaseHeartbeat(collection, session, list(flag(args, '--keys')));
        break;
      case 'release':
        r = await coord.leaseRelease(need(collection, '--collection'), need(flag(args, '--key'), '--key'), session, flag(args, '--outcome'));
        break;
      case 'list':
        r = await coord.leaseList(need(collection, '--collection'), args.includes('--include-expired'));
        break;
      case 'counter-next':
        r = await coord.counterNext(need(collection, '--collection'), need(flag(args, '--name'), '--name'), int(flag(args, '--floor'), '--floor'));
        break;
      case 'task-id':
        r = await coord.nextTaskId(int(flag(args, '--floor'), '--floor'));
        break;
      default:
        process.stderr.write(COORD_USAGE);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`yapa coord ${sub}: ${e instanceof Error ? e.message : e}\n`);
    return 2;
  }
  process.stdout.write((args.includes('--text') ? r.text : JSON.stringify(r.json)) + '\n');
  return r.exit;
}

async function main(): Promise<void> {
  const [command, sub, ...rest] = process.argv.slice(2);
  if (command === 'coord') {
    // Exit explicitly: an idle keep-alive socket or timer must not hold the process.
    process.exit(await runCoord(sub, rest));
  }
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
