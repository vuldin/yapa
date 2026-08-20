#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

import {
  getConfig,
  detectChromaVersion,
  markDecayRun,
  runDecaySweep,
  shouldRunDecay,
  startCuration,
  startSync,
} from '@yapa/core';

const server = new McpServer({
  name: 'yapa',
  version: '0.1.0',
});

registerTools(server);
registerResources(server);
registerPrompts(server);

async function healthCheck(): Promise<{healthy: boolean, error?: string, version?: string}> {
  const versionCheck = await detectChromaVersion();
  
  if (!versionCheck.isV2) {
    return {
      healthy: false,
      version: versionCheck.version,
      error: versionCheck.error || 'ChromaDB v2 required'
    };
  }
  
  // Verify heartbeat works
  try {
    const response = await fetch(`${getConfig().CHROMA_URL}/api/v2/heartbeat`);
    if (!response.ok) {
      return {
        healthy: false,
        version: versionCheck.version,
        error: `ChromaDB v2 (${versionCheck.version}) is not responding to heartbeat`
      };
    }
  } catch (e) {
    return {
      healthy: false,
      version: versionCheck.version,
      error: `Cannot connect to ChromaDB v2: ${e}`
    };
  }
  
  return {
    healthy: true,
    version: versionCheck.version
  };
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
  if (getConfig().STORAGE === 'local') {
    // Embedded store: no server to health-check.
    process.stderr.write(`✅ YAPA started with the embedded local store at ${getConfig().LOCAL_STORE_PATH} (embeddings: ${getConfig().EMBEDDING_PROVIDER})\n`);
  } else {
    const health = await healthCheck();

    if (!health.healthy) {
      process.stderr.write(`\n❌ YAPA failed to start:\n`);
      process.stderr.write(`   ${health.error}\n\n`);
      process.stderr.write(`To upgrade ChromaDB:\n`);
      process.stderr.write(`  • Docker: docker pull chromadb/chroma:latest && docker restart chromadb\n`);
      process.stderr.write(`  • pip: pip install --upgrade chromadb && chroma run --host 0.0.0.0 --port 8000\n`);
      process.stderr.write(`  • NixOS: Update to latest chromadb package\n\n`);
      process.stderr.write(`  • Or skip the server entirely: YAPA_STORAGE=local\n\n`);
      process.stderr.write(`ChromaDB URL: ${getConfig().CHROMA_URL}\n`);
      process.exit(1);
    }

    process.stderr.write(`✅ YAPA started with ChromaDB v${health.version} at ${getConfig().CHROMA_URL} (embeddings: ${getConfig().EMBEDDING_PROVIDER})\n`);
  }
  
  // Run decay in background, don't block startup
  startupDecay();

  // Start background curation if enabled
  if (getConfig().CURATION_ENABLED) {
    startCuration().catch(e => process.stderr.write(`[yapa] Curation startup error: ${e}\n`));
  }

  // Start remote sync if enabled
  if (getConfig().SYNC_ENABLED) {
    startSync().catch(e => process.stderr.write(`[yapa] Sync startup error: ${e}\n`));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`[yapa] Fatal: ${e}\n`);
  process.exit(1);
});
