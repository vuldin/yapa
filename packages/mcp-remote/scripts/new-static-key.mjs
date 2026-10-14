#!/usr/bin/env node
// Generate a yapa-mcp static key (ADP "Static Key" auth).
//
// Usage:
//   node packages/mcp-remote/scripts/new-static-key.mjs <principal> [kid]
//     principal  reserved service username the key acts as, e.g. svc-adp
//     kid        key id (default: <principal minus svc->-<yyyymmdd>)
//
// Prints the key ONCE (paste it into ADP; it is not stored anywhere) and the
// JSON entry to merge into the YAPA_MCP_STATIC_KEYS secret, which holds only
// the sha256. See docs/adp-onboarding.md for rotation.
import { createHash, randomBytes } from 'node:crypto';

const PRINCIPAL_RE = /^svc-[a-z0-9-]{1,60}$/;
const KID_RE = /^[A-Za-z0-9-]{1,32}$/;

const [principal, kidArg] = process.argv.slice(2);
if (!principal || !PRINCIPAL_RE.test(principal)) {
  console.error('usage: new-static-key.mjs <principal: svc-...> [kid]');
  process.exit(2);
}
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const kid = kidArg ?? `${principal.slice(4)}-${today}`.slice(0, 32);
if (!KID_RE.test(kid)) {
  console.error(`kid must match ${KID_RE}`);
  process.exit(2);
}

const key = `yapa_sk_${kid}_${randomBytes(32).toString('base64url')}`;
const sha256 = createHash('sha256').update(key, 'utf8').digest('hex');

process.stderr.write('Static key (shown once; store it only in ADP):\n');
process.stdout.write(`${key}\n`);
process.stderr.write('\nMerge this entry into the YAPA_MCP_STATIC_KEYS secret JSON:\n');
process.stdout.write(`${JSON.stringify({ [kid]: { principal, sha256 } }, null, 2)}\n`);
