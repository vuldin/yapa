#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CHROMA_URL, EMBEDDING_PROVIDER, SYNC_ENABLED } from './config.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { shouldRunDecay, runDecaySweep, markDecayRun } from './memory/decay.js';
import { startSync } from './sync/index.js';

const server = new McpServer({
  name: 'yapa',
  version: '0.1.0',
});

registerTools(server);
registerResources(server);
registerPrompts(server);

async function healthCheck(): Promise<boolean> {
  try {
    const response = await fetch(`${CHROMA_URL}/api/v2/heartbeat`);
    return response.ok;
  } catch {
    return false;
  }
}

async function startupDecay(): Promise<void> {
  try {
    if (await shouldRunDecay()) {
      const count = await runDecaySweep();
      await markDecayRun();
      if (count > 0) {
        process.stderr.write(`[yapa] Decay sweep: ${count} documents updated\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`[yapa] Decay sweep skipped: ${e}\n`);
  }
}

async function main(): Promise<void> {
  const healthy = await healthCheck();
  if (healthy) {
    process.stderr.write(`[yapa] Connected to ChromaDB at ${CHROMA_URL} (embeddings: ${EMBEDDING_PROVIDER})\n`);
    // Run decay in background, don't block startup
    startupDecay();
    // Start remote sync if enabled
    if (SYNC_ENABLED) {
      startSync().catch(e => process.stderr.write(`[yapa] Sync startup error: ${e}\n`));
    }
  } else {
    process.stderr.write(`[yapa] Warning: ChromaDB at ${CHROMA_URL} is not reachable. Tools will fail until it's available.\n`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`[yapa] Fatal: ${e}\n`);
  process.exit(1);
});
