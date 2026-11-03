#!/usr/bin/env node
import { createRequire as __yapaCreateRequire } from 'node:module'; const require = __yapaCreateRequire(import.meta.url);

// packages/mcp/src/cli/statusline.ts
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var SCRIPT_VERSION = true ? "1.10.1" : void 0;
var SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
function newer(a, b) {
  const pa = SEMVER.exec(String(a ?? "").trim());
  const pb = SEMVER.exec(String(b ?? "").trim());
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0;
  }
  if (pa[4] && !pb[4]) return false;
  if (!pa[4] && pb[4]) return true;
  return (pa[4] ?? "") > (pb[4] ?? "");
}
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
function remoteName(health, explicit) {
  const legacy = cleanLabel(health?.label);
  return cleanLabel(explicit) ?? cleanLabel(health?.remote) ?? (legacy && legacy !== "yapa" ? legacy : void 0);
}
function renderSegment(health, now, opts = {}) {
  const paint = (tone, text) => opts.color ? `${ANSI[tone]}${text}${ANSI.reset}` : text;
  const installed = opts.version ?? SCRIPT_VERSION ?? opts.update?.current;
  const running = opts.session?.version ?? installed;
  const restart = installed && (opts.session?.missing || opts.session?.version && newer(installed, opts.session.version)) ? installed : void 0;
  const latest = opts.update?.latest && installed && newer(opts.update.latest, installed) ? opts.update.latest : void 0;
  const remote = remoteName(health, opts.remote ?? opts.label);
  const shown = opts.session?.missing ? "yapa" : `yapa${running ? `@v${running}` : ""}`;
  const head = shown + (restart ? ` ${paint("yellow", `(restart for v${restart})`)}` : "") + (latest ? ` ${paint("yellow", `(v${latest} available)`)}` : "") + (remote ? ` <-> ${remote}` : "");
  const push = health?.unpushed ? ` \xB7 ${health.unpushed} to push` : "";
  const since = health?.since ? ` since ${formatSince(health.since, now)}` : "";
  const tail = cleanCollection(opts.collection);
  const state = (tone, text) => `${head} ${paint(tone, text)}${tail ? ` | ${tail}` : ""}`;
  if (!health) return state("dim", "\u25CB sync status unknown");
  switch (health.status) {
    case "disabled":
      return state("dim", "\u25CB local only");
    case "signed_out":
      return state("red", `\u25CF signed out${since}${push} \xB7 run: gcloud auth login`);
    case "unreachable":
      return state("yellow", `\u25CF offline${since}${push}`);
    case "error": {
      const why = health.message ? `: ${health.message.replace(/\s+/g, " ").slice(0, 60)}` : "";
      return state("yellow", `\u25CF sync error${since}${why}`);
    }
    case "ok": {
      const interval = health.interval_ms && health.interval_ms > 0 ? health.interval_ms : DEFAULT_INTERVAL_MS;
      if (now - health.at > STALE_INTERVALS * interval) {
        return state("dim", `\u25CB sync status unknown (last checked ${formatAgo(now - health.at)})`);
      }
      return state("green", `\u25CF synced ${formatAgo(now - (health.last_ok_at ?? health.at))}${push}`);
    }
    default:
      return state("dim", "\u25CB sync status unknown");
  }
}
function cleanCollection(name) {
  if (typeof name !== "string") return void 0;
  const v = name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 64);
  return v || void 0;
}
function readLastWrite(dir, sessions) {
  let best;
  for (const s of new Set(sessions)) {
    if (!s || !/^[A-Za-z0-9._:-]{1,128}$/.test(s)) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, `${s.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), "utf-8"));
      if (r && typeof r.collection === "string" && typeof r.at === "number" && (!best || r.at > best.at)) best = r;
    } catch {
    }
  }
  return best;
}
function stdinSession(input) {
  return stdinInfo(input).session;
}
function stdinInfo(input, now = Date.now()) {
  let j;
  try {
    j = JSON.parse(input);
  } catch {
    return {};
  }
  const session = typeof j?.session_id === "string" ? j.session_id : void 0;
  let ageMs = typeof j?.cost?.total_duration_ms === "number" ? j.cost.total_duration_ms : void 0;
  if (ageMs === void 0 && typeof j?.transcript_path === "string") {
    try {
      const born = statSync(j.transcript_path).birthtimeMs;
      if (born > 0) ageMs = now - born;
    } catch {
    }
  }
  return { session, ageMs };
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function readSessionRecord(dir, sessions) {
  let best;
  for (const s of new Set(sessions)) {
    if (!s || !/^[A-Za-z0-9._:-]{1,128}$/.test(s)) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, `${s.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), "utf-8"));
      if (r && typeof r.version === "string" && typeof r.pid === "number" && alive(r.pid) && (!best || r.started_at > best.started_at)) best = r;
    } catch {
    }
  }
  return best;
}
var SESSION_REPORT_GRACE_MS = 6e4;
function sessionInfo(record, ageMs) {
  if (record) return { version: record.version };
  if (ageMs !== void 0 && ageMs > SESSION_REPORT_GRACE_MS) return { missing: true };
  return void 0;
}
function readUpdate(path) {
  try {
    const u = JSON.parse(readFileSync(path, "utf-8"));
    return u && typeof u === "object" ? { current: typeof u.current === "string" ? u.current : void 0, latest: typeof u.latest === "string" ? u.latest : void 0 } : void 0;
  } catch {
    return void 0;
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
function isYapaStatusLine(statusLine, script) {
  if (typeof statusLine?.command !== "string") return false;
  return /yapa[\\/]statusline\.mjs/.test(statusLine.command) || !!script && statusLine.command.includes(`"${script}"`);
}
function wrappedOf(statusLine) {
  const m = typeof statusLine?.command === "string" ? statusLine.command.match(/--wrap\s+([A-Za-z0-9_-]+)/) : null;
  return m ? decodeWrapped(m[1]) : void 0;
}
function mergeStatusLine(settings, script, refreshInterval = 30) {
  const next = structuredClone(settings ?? {});
  const current = next.statusLine;
  const wrapped = isYapaStatusLine(current, script) ? wrappedOf(current) : current && typeof current === "object" ? current : void 0;
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
function removeStatusLine(settings, script) {
  const next = structuredClone(settings ?? {});
  if (!isYapaStatusLine(next.statusLine, script)) return next;
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
function uninstallStatusLine(path = defaultSettingsPath(), script) {
  writeSettings(path, removeStatusLine(readSettings(path), script));
  return path;
}
function hasStatusLine(path = defaultSettingsPath(), script) {
  try {
    return isYapaStatusLine(JSON.parse(readFileSync(path, "utf-8")).statusLine, script);
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
var REMOVED_MARKER = "statusline-removed";
function setRemovedMarker(dir, removed) {
  const p = join(dir, REMOVED_MARKER);
  try {
    if (removed) {
      mkdirSync(dir, { recursive: true, mode: 448 });
      writeFileSync(p, `${(/* @__PURE__ */ new Date()).toISOString()}
`);
    } else {
      rmSync(p, { force: true });
    }
  } catch {
  }
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
    setRemovedMarker(dirname(self2), false);
    return;
  }
  if (args.includes("--uninstall")) {
    process.stdout.write(`Status line removed from ${uninstallStatusLine(settings, self2)}
`);
    setRemovedMarker(dirname(self2), true);
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
  const update = readUpdate(join(dirname(healthPath), "update-check.json"));
  const info = stdinInfo(input);
  const ids = [info.session, process.env.CLAUDE_CODE_SESSION_ID];
  const last = readLastWrite(join(dirname(healthPath), "last-write"), ids);
  const session = sessionInfo(readSessionRecord(join(dirname(healthPath), "sessions"), ids), info.ageMs);
  const color = !process.env.NO_COLOR;
  process.stdout.write(renderSegment(readHealth(healthPath), Date.now(), {
    color,
    remote: argValue(args, "--remote") ?? argValue(args, "--label"),
    update,
    collection: last?.collection,
    session
  }) + "\n");
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
  main(process.argv.slice(2), self).catch(() => process.stdout.write(`yapa${SCRIPT_VERSION ? `@v${SCRIPT_VERSION}` : ""} \u25CB sync status unknown
`));
}
export {
  REMOVED_MARKER,
  SCRIPT_VERSION,
  SESSION_REPORT_GRACE_MS,
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
  newer,
  readHealth,
  readLastWrite,
  readSessionRecord,
  readUpdate,
  removeStatusLine,
  renderSegment,
  sessionInfo,
  setRemovedMarker,
  stdinInfo,
  stdinSession,
  uninstallStatusLine
};
