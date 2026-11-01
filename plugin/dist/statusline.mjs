#!/usr/bin/env node
import { createRequire as __yapaCreateRequire } from 'node:module'; const require = __yapaCreateRequire(import.meta.url);

// packages/mcp/src/cli/statusline.ts
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var DEFAULT_INTERVAL_MS = 3e5;
var STALE_INTERVALS = 3;
var WRAP_TIMEOUT_MS = 5e3;
var ANSI = { green: "\x1B[32m", red: "\x1B[31m", yellow: "\x1B[33m", dim: "\x1B[2m", reset: "\x1B[0m" };
function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1e3));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function formatSince(at, now) {
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date(now).toDateString()) return hhmm;
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${hhmm}`;
}
function cleanLabel(label) {
  if (typeof label !== "string") return void 0;
  const v = label.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 32);
  return v || void 0;
}
function renderSegment(health, now, opts = {}) {
  const name = cleanLabel(opts.label) ?? cleanLabel(health?.label) ?? "yapa";
  const paint = (tone, text) => opts.color ? `${ANSI[tone]}${text}${ANSI.reset}` : text;
  const push = health?.unpushed ? ` \xB7 ${health.unpushed} to push` : "";
  const since = health?.since ? ` since ${formatSince(health.since, now)}` : "";
  if (!health) return paint("dim", `${name} \u25CB sync status unknown`);
  switch (health.status) {
    case "disabled":
      return paint("dim", `${name} \u25CB local only`);
    case "signed_out":
      return paint("red", `${name} \u25CF signed out${since}${push} \xB7 run: gcloud auth login`);
    case "unreachable":
      return paint("yellow", `${name} \u25CF offline${since}${push}`);
    case "error": {
      const why = health.message ? `: ${health.message.replace(/\s+/g, " ").slice(0, 60)}` : "";
      return paint("yellow", `${name} \u25CF sync error${since}${why}`);
    }
    case "ok": {
      const interval = health.interval_ms && health.interval_ms > 0 ? health.interval_ms : DEFAULT_INTERVAL_MS;
      if (now - health.at > STALE_INTERVALS * interval) {
        return paint("dim", `${name} \u25CB sync status unknown (last checked ${formatAgo(now - health.at)})`);
      }
      return paint("green", `${name} \u25CF synced ${formatAgo(now - (health.last_ok_at ?? health.at))}${push}`);
    }
    default:
      return paint("dim", `${name} \u25CB sync status unknown`);
  }
}
function readHealth(path) {
  try {
    const h = JSON.parse(readFileSync(path, "utf-8"));
    return h && typeof h.status === "string" && typeof h.at === "number" ? h : void 0;
  } catch {
    return void 0;
  }
}
function encodeWrapped(statusLine) {
  return Buffer.from(JSON.stringify(statusLine)).toString("base64url");
}
function decodeWrapped(b64) {
  try {
    const v = JSON.parse(Buffer.from(b64, "base64url").toString("utf-8"));
    return v && typeof v === "object" ? v : void 0;
  } catch {
    return void 0;
  }
}
function isYapaStatusLine(statusLine) {
  return typeof statusLine?.command === "string" && /yapa[\\/]statusline\.mjs/.test(statusLine.command);
}
function wrappedOf(statusLine) {
  const m = typeof statusLine?.command === "string" ? statusLine.command.match(/--wrap\s+([A-Za-z0-9_-]+)/) : null;
  return m ? decodeWrapped(m[1]) : void 0;
}
function mergeStatusLine(settings, script, refreshInterval = 30) {
  const next = structuredClone(settings ?? {});
  const current = next.statusLine;
  const wrapped = isYapaStatusLine(current) ? wrappedOf(current) : current && typeof current === "object" ? current : void 0;
  let command = `node "${script}"`;
  if (wrapped) command += ` --wrap ${encodeWrapped(wrapped)}`;
  next.statusLine = {
    ...wrapped ?? {},
    type: "command",
    command,
    refreshInterval: Math.min(Number(wrapped?.refreshInterval) || refreshInterval, refreshInterval)
  };
  return next;
}
function removeStatusLine(settings) {
  const next = structuredClone(settings ?? {});
  if (!isYapaStatusLine(next.statusLine)) return next;
  const wrapped = wrappedOf(next.statusLine);
  if (wrapped) next.statusLine = wrapped;
  else delete next.statusLine;
  return next;
}
function defaultSettingsPath() {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}
function readSettings(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`Refusing to edit ${path}: ${e?.message ?? e}`);
  }
}
function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, path);
}
function installStatusLine(script, path = defaultSettingsPath()) {
  writeSettings(path, mergeStatusLine(readSettings(path), script));
  return path;
}
function uninstallStatusLine(path = defaultSettingsPath()) {
  writeSettings(path, removeStatusLine(readSettings(path)));
  return path;
}
function hasStatusLine(path = defaultSettingsPath()) {
  try {
    return isYapaStatusLine(JSON.parse(readFileSync(path, "utf-8")).statusLine);
  } catch {
    return false;
  }
}
function copyScript(from, to) {
  let src;
  try {
    src = readFileSync(from);
  } catch {
    return false;
  }
  try {
    if (readFileSync(to).equals(src)) return false;
  } catch {
  }
  mkdirSync(dirname(to), { recursive: true, mode: 448 });
  const tmp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
  return true;
}
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : void 0;
}
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}
async function main(args, self2) {
  const settings = argValue(args, "--settings");
  if (args.includes("--install")) {
    process.stdout.write(`Status line added to ${installStatusLine(self2, settings)}
`);
    return;
  }
  if (args.includes("--uninstall")) {
    process.stdout.write(`Status line removed from ${uninstallStatusLine(settings)}
`);
    return;
  }
  const input = await readStdin();
  const wrapped = argValue(args, "--wrap");
  const previous = wrapped ? decodeWrapped(wrapped) : void 0;
  if (typeof previous?.command === "string") {
    const r = spawnSync(previous.command, { shell: true, input, encoding: "utf-8", timeout: WRAP_TIMEOUT_MS });
    const out = (r.stdout ?? "").replace(/\s+$/, "");
    if (r.status === 0 && out) process.stdout.write(out + "\n");
  }
  const healthPath = process.env.YAPA_SYNC_HEALTH_FILE || join(dirname(self2), "sync-health.json");
  const color = !process.env.NO_COLOR;
  process.stdout.write(renderSegment(readHealth(healthPath), Date.now(), { color, label: argValue(args, "--label") }) + "\n");
}
function isMain(argv1, self2) {
  if (!argv1 || !/statusline\.m?js$/.test(self2)) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(self2);
  } catch {
    return false;
  }
}
var self = fileURLToPath(import.meta.url);
if (isMain(process.argv[1], self)) {
  main(process.argv.slice(2), self).catch(() => process.stdout.write("yapa \u25CB sync status unknown\n"));
}
export {
  copyScript,
  decodeWrapped,
  defaultSettingsPath,
  encodeWrapped,
  formatAgo,
  formatSince,
  hasStatusLine,
  installStatusLine,
  isYapaStatusLine,
  main,
  mergeStatusLine,
  readHealth,
  removeStatusLine,
  renderSegment,
  uninstallStatusLine
};
