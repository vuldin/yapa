#!/usr/bin/env node

import { sessionStart, userPromptSubmit, stop, sessionEnd } from './hooks.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function usage(): never {
  process.stderr.write(
    'Usage: yapa hook <session-start|user-prompt-submit|stop|session-end>\n' +
      '       (reads hook JSON from stdin)\n',
  );
  process.exit(2);
}

async function dispatchHook(name: string): Promise<void> {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};

  switch (name) {
    case 'session-start':
      return sessionStart(input);
    case 'user-prompt-submit':
      return userPromptSubmit(input);
    case 'stop':
      return stop(input);
    case 'session-end':
      return sessionEnd(input);
    default:
      usage();
  }
}

async function main(): Promise<void> {
  const [command, sub] = process.argv.slice(2);
  if (command !== 'hook' || !sub) usage();

  try {
    await dispatchHook(sub);
  } catch (e) {
    process.stderr.write(`[yapa] hook ${sub} failed: ${e}\n`);
    process.stdout.write('{}');
    process.exit(0);
  }
}

main();
