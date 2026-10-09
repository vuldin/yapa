#!/usr/bin/env node
// Copy the shared YAPA database (v1, direct-DB sync) into the new Cloud SQL
// instance (schema v2, infra/cloudsql/sql/), then verify the copy (josh-310).
//
// Copies `documents` and `schema_version`. Idempotent: rows are upserted by
// id, so the script can be re-run (for example after a final freeze).
//
// Never copies local-only rows (collection `global`, `private-*`, `local-*`)
// or journal drafts. Rows whose embedding is not 384-dimensional are reported
// and skipped (re-embedding is out of scope here).
//
// Env:
//   SOURCE_DATABASE_URL   current database (read only)
//   TARGET_DATABASE_URL   new database, as the admin (writes); optional with --dry-run
//   SOURCE_CA_CERT        optional server CA (PEM) -> verify-ca
//   TARGET_CA_CERT        optional server CA (PEM) -> verify-ca
//
// Usage:
//   node scripts/migrate-db.mjs --dry-run
//   node scripts/migrate-db.mjs [--batch-size 200] [--sample 50] [--seed-users users.json]
//   node scripts/migrate-db.mjs --verify-only
//
// users.json maps username -> email, e.g. {"alice": "alice@example.com"}.
// Every distinct origin_user is seeded into `users`: mapped names get their
// email and active = true; unmapped names get a placeholder
// `<username>@unmapped.invalid`, active = false, so the name stays reserved
// until an admin fills it in. Re-running only replaces placeholder rows.
//
// TLS: with a CA file the server cert is verified against it but the
// hostname is not checked (Cloud SQL certs name the instance, and the target
// is usually reached through a localhost tunnel). Without one the connection
// is still encrypted (unless sslmode=disable) but unverified, with a warning.
//
// Exit code: 0 when the copy verifies, 1 on verification failure, 2 on usage
// or connection errors.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const DIMS = 384;
const PLACEHOLDER_DOMAIN = 'unmapped.invalid';
const USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLLECTION_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { dryRun: false, verifyOnly: false, batchSize: 200, sample: 50, seedUsers: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verify-only') opts.verifyOnly = true;
    else if (a === '--batch-size') opts.batchSize = toPositiveInt(next(), a);
    else if (a === '--sample') opts.sample = toPositiveInt(next(), a);
    else if (a === '--seed-users') opts.seedUsers = next();
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument: ${a}`);
  }
  if (opts.dryRun && opts.verifyOnly) usage('--dry-run and --verify-only are exclusive');
  return opts;
}

function toPositiveInt(v, name) {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) usage(`${name} must be a positive integer`);
  return n;
}

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('usage: node scripts/migrate-db.mjs [--dry-run | --verify-only] [--batch-size N] [--sample N] [--seed-users users.json]');
  process.exit(msg ? 2 : 0);
}

// ---------------------------------------------------------------- connections

function connConfig(label, databaseUrl, caPath) {
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error(`${label}: not a valid postgres:// URL`); }
  const sslmode = url.searchParams.get('sslmode');
  // node-postgres lets URL ssl params override the ssl object; strip them.
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) url.searchParams.delete(k);
  const connectionString = url.toString();
  if (caPath) {
    return {
      tls: 'verify-ca',
      config: { connectionString, ssl: { ca: readFileSync(caPath, 'utf-8'), rejectUnauthorized: true, checkServerIdentity: () => undefined } },
    };
  }
  if (sslmode === 'disable') return { tls: 'off', config: { connectionString, ssl: false } };
  return { tls: 'unverified', config: { connectionString, ssl: { rejectUnauthorized: false } } };
}

async function connect(label, envUrl, envCa) {
  const databaseUrl = process.env[envUrl];
  if (!databaseUrl) throw new Error(`${envUrl} is not set`);
  const { tls, config } = connConfig(label, databaseUrl, process.env[envCa]);
  if (tls === 'unverified') console.warn(`warning: ${label} TLS is not verified; set ${envCa} for verify-ca`);
  const client = new pg.Client({ ...config, application_name: 'yapa-migrate-db' });
  await client.connect();
  const { rows } = await client.query('SELECT current_user AS u, version() AS v');
  console.log(`${label}: connected as ${rows[0].u} (tls ${tls}; ${rows[0].v.split(' on ')[0]})`);
  return client;
}

// ---------------------------------------------------------------- rules

function isLocalOnly(collection) {
  return collection === 'global' || collection.startsWith('private-') || collection.startsWith('local-');
}

/** Reason a source row must not be copied, or null. */
function skipReason(row) {
  if (isLocalOnly(row.collection)) return 'local_only_collection';
  if (row.metadata && row.metadata.type === 'journal_draft') return 'journal_draft';
  if (row.dims !== DIMS) return 'embedding_dimension';
  return null;
}

function parseVector(text) {
  return JSON.parse(text);
}

function normWarning(vec) {
  let sum = 0;
  for (const x of vec) {
    if (!Number.isFinite(x)) return 'non-finite';
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  return Math.abs(norm - 1) > 0.01 ? `norm ${norm.toFixed(4)}` : null;
}

function sha(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

// Canonical JSON (sorted keys) so jsonb key order does not cause false diffs.
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function inc(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// ---------------------------------------------------------------- source scan

const SOURCE_COLUMNS = `id, collection, content, embedding::text AS embedding, vector_dims(embedding) AS dims,
  metadata, origin_user, related_ids, synced_at, created_at, updated_at`;

/** Pages through source documents by id inside the caller's snapshot. */
async function* scanSource(source, batchSize) {
  let after = '';
  for (;;) {
    const { rows } = await source.query(
      `SELECT ${SOURCE_COLUMNS} FROM documents WHERE id > $1 ORDER BY id LIMIT $2`,
      [after, batchSize],
    );
    if (rows.length === 0) return;
    yield rows;
    after = rows[rows.length - 1].id;
  }
}

// ---------------------------------------------------------------- target writes

async function checkTargetSchema(target) {
  const problems = [];
  const v = await target.query('SELECT max(version) AS v FROM schema_version').catch(() => ({ rows: [{ v: null }] }));
  if (!(v.rows[0].v >= 2)) problems.push(`schema_version is ${v.rows[0].v ?? 'missing'}, need >= 2 (run infra/cloudsql/sql/*.sql)`);
  const dim = await target.query(`
    SELECT a.atttypmod AS dims FROM pg_attribute a
     WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'embedding'`).catch(() => ({ rows: [] }));
  if (dim.rows[0]?.dims !== DIMS) problems.push(`documents.embedding is not vector(${DIMS})`);
  const cols = await target.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'documents' AND column_name IN ('last_editor', 'last_device')`);
  if (cols.rows.length !== 2) problems.push('documents is missing last_editor/last_device (v2)');
  const users = await target.query(`SELECT to_regclass('public.users') AS t`);
  if (!users.rows[0].t) problems.push('users table missing (v2)');
  return problems;
}

// last_device is backfilled from metadata.origin_device (the device of the
// last push, which is what the service's echo rule needs). last_editor stays
// NULL: v1 did not record who last edited a row.
async function upsertBatch(target, rows) {
  const cols = ['id', 'collection', 'content', 'embedding', 'metadata', 'origin_user', 'related_ids',
    'synced_at', 'created_at', 'updated_at', 'last_device'];
  const casts = ['', '', '', '::vector(384)', '::jsonb', '', '::text[]', '::timestamptz', '::timestamptz', '::timestamptz', ''];
  const params = [];
  const tuples = rows.map(r => {
    const values = [r.id, r.collection, r.content, r.embedding, JSON.stringify(r.metadata ?? {}), r.origin_user,
      r.related_ids ?? [], r.synced_at, r.created_at, r.updated_at, r.metadata?.origin_device ?? null];
    const ph = values.map((v, i) => {
      params.push(v);
      return `$${params.length}${casts[i]}`;
    });
    return `(${ph.join(', ')})`;
  });
  const updates = cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ');
  await target.query(
    `INSERT INTO documents (${cols.join(', ')}) VALUES ${tuples.join(', ')}
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
    params,
  );
}

async function copySchemaVersion(source, target, dryRun) {
  const { rows } = await source.query('SELECT version, applied_at FROM schema_version ORDER BY version');
  console.log(`schema_version (source): ${rows.map(r => r.version).join(', ') || '(none)'}`);
  if (dryRun || rows.length === 0) return;
  for (const r of rows) {
    await target.query(
      'INSERT INTO schema_version (version, applied_at) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
      [r.version, r.applied_at],
    );
  }
}

// ---------------------------------------------------------------- users

function loadUserMap(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path}: expected an object {username: email}`);
  for (const [u, e] of Object.entries(raw)) {
    if (!USERNAME_RE.test(u)) throw new Error(`${path}: invalid username ${JSON.stringify(u)}`);
    if (typeof e !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(`${path}: invalid email for ${u}`);
  }
  return raw;
}

async function seedUsers(target, usernames, map, dryRun) {
  const plan = [];
  for (const u of [...usernames].sort()) {
    if (!USERNAME_RE.test(u)) {
      plan.push({ u, action: 'invalid username, not seeded (fix by hand)' });
      continue;
    }
    const email = map[u];
    plan.push(email
      ? { u, email, active: true, action: 'mapped' }
      : { u, email: `${u}@${PLACEHOLDER_DOMAIN}`, active: false, action: 'placeholder (inactive)' });
  }
  for (const u of Object.keys(map)) {
    if (!usernames.has(u)) plan.push({ u, email: map[u], active: true, action: 'mapped, no rows yet' });
  }
  console.log('\nusers seed plan:');
  for (const p of plan) console.log(`  ${p.u.padEnd(24)} ${p.action}`);
  if (dryRun) return;
  for (const p of plan) {
    if (!p.email) continue;
    // Only replace rows that still hold a placeholder; never clobber an admin's edit.
    await target.query(
      `INSERT INTO users (username, email, active, disabled_at)
       VALUES ($1, $2, $3::boolean, CASE WHEN $3::boolean THEN NULL ELSE now() END)
       ON CONFLICT (username) DO UPDATE
         SET email = EXCLUDED.email, active = EXCLUDED.active, disabled_at = EXCLUDED.disabled_at
       WHERE users.email LIKE ('%@' || $4::text)`,
      [p.u, p.email, p.active, PLACEHOLDER_DOMAIN],
    );
  }
}

// ---------------------------------------------------------------- verification

async function targetAggregates(target) {
  const total = Number((await target.query('SELECT count(*) AS n FROM documents')).rows[0].n);
  const byCollection = new Map((await target.query(
    'SELECT collection AS k, count(*) AS n FROM documents GROUP BY 1')).rows.map(r => [r.k, Number(r.n)]));
  const byUser = new Map((await target.query(
    'SELECT origin_user AS k, count(*) AS n FROM documents GROUP BY 1')).rows.map(r => [r.k, Number(r.n)]));
  const localOnly = Number((await target.query(`
    SELECT count(*) AS n FROM documents
     WHERE collection = 'global' OR collection LIKE 'private-%' OR collection LIKE 'local-%'`)).rows[0].n);
  const badDims = Number((await target.query(
    'SELECT count(*) AS n FROM documents WHERE vector_dims(embedding) <> $1', [DIMS])).rows[0].n);
  const ids = new Set((await target.query('SELECT id FROM documents')).rows.map(r => r.id));
  return { total, byCollection, byUser, localOnly, badDims, ids };
}

function diffMaps(label, expected, actual, failures) {
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  for (const k of [...keys].sort()) {
    const e = expected.get(k) ?? 0;
    const a = actual.get(k) ?? 0;
    if (e !== a) failures.push(`${label} ${JSON.stringify(k)}: source ${e}, target ${a}`);
  }
}

function pickSample(ids, n) {
  const arr = [...ids];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

async function verifySample(source, target, ids, failures) {
  if (ids.length === 0) return 0;
  const q = `SELECT id, collection, content, embedding::text AS embedding, metadata, origin_user,
                    related_ids, created_at, updated_at
               FROM documents WHERE id = ANY($1::text[])`;
  const src = new Map((await source.query(q, [ids])).rows.map(r => [r.id, r]));
  const tgt = new Map((await target.query(q, [ids])).rows.map(r => [r.id, r]));
  let ok = 0;
  for (const id of ids) {
    const s = src.get(id);
    const t = tgt.get(id);
    if (!s || !t) { failures.push(`sample ${id}: missing on ${s ? 'target' : 'source'}`); continue; }
    const sv = parseVector(s.embedding);
    const tv = parseVector(t.embedding);
    const bad = [];
    if (sv.length !== tv.length || sv.some((x, i) => Math.fround(x) !== Math.fround(tv[i]))) bad.push('embedding');
    if (sha(s.content) !== sha(t.content)) bad.push('content');
    if (canon(s.metadata) !== canon(t.metadata)) bad.push('metadata');
    for (const f of ['collection', 'origin_user']) if (s[f] !== t[f]) bad.push(f);
    for (const f of ['created_at', 'updated_at']) if (+s[f] !== +t[f]) bad.push(f);
    if (canon(s.related_ids ?? []) !== canon(t.related_ids ?? [])) bad.push('related_ids');
    if (bad.length) failures.push(`sample ${id}: differs in ${bad.join(', ')}`);
    else ok++;
  }
  return ok;
}

// ---------------------------------------------------------------- main

function printCounts(title, map) {
  console.log(`\n${title}:`);
  for (const [k, n] of [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))) {
    console.log(`  ${String(k).padEnd(40)} ${n}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const userMap = opts.seedUsers ? loadUserMap(opts.seedUsers) : null;
  const mode = opts.dryRun ? 'dry-run (read only)' : opts.verifyOnly ? 'verify only' : 'copy + verify';
  console.log(`yapa migrate-db: ${mode}`);

  const source = await connect('source', 'SOURCE_DATABASE_URL', 'SOURCE_CA_CERT');
  let target = null;
  if (process.env.TARGET_DATABASE_URL || !opts.dryRun) {
    target = await connect('target', 'TARGET_DATABASE_URL', 'TARGET_CA_CERT');
  }

  try {
    if (target) {
      const problems = await checkTargetSchema(target);
      if (problems.length) {
        for (const p of problems) console.error(`target schema: ${p}`);
        if (!opts.dryRun) throw new Error('target schema is not ready');
      }
    }

    // One consistent snapshot of the source for the copy and the expected counts.
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const expected = { total: 0, byCollection: new Map(), byUser: new Map(), ids: new Set() };
    const skipped = new Map(); // reason -> [{id, collection, dims}]
    const warnings = [];
    let sourceTotal = 0;
    let written = 0;

    for await (const rows of scanSource(source, opts.batchSize)) {
      const eligible = [];
      for (const r of rows) {
        sourceTotal++;
        const reason = skipReason(r);
        if (reason) {
          if (!skipped.has(reason)) skipped.set(reason, []);
          skipped.get(reason).push({ id: r.id, collection: r.collection, dims: r.dims });
          continue;
        }
        const w = normWarning(parseVector(r.embedding));
        if (w) warnings.push(`${r.id}: embedding ${w}`);
        if (!COLLECTION_RE.test(r.collection)) warnings.push(`${r.id}: collection name ${JSON.stringify(r.collection)} will fail service validation`);
        eligible.push(r);
        expected.total++;
        expected.ids.add(r.id);
        inc(expected.byCollection, r.collection);
        inc(expected.byUser, r.origin_user);
      }
      if (!opts.dryRun && !opts.verifyOnly && eligible.length) {
        await target.query('BEGIN');
        try {
          await upsertBatch(target, eligible);
          await target.query('COMMIT');
        } catch (err) {
          await target.query('ROLLBACK');
          throw err;
        }
        written += eligible.length;
        process.stdout.write(`\r  upserted ${written} row(s)`);
      }
    }
    if (written) process.stdout.write('\n');

    await copySchemaVersion(source, target, opts.dryRun || opts.verifyOnly);

    console.log(`\nsource rows: ${sourceTotal}; eligible: ${expected.total}; skipped: ${sourceTotal - expected.total}`);
    for (const [reason, list] of skipped) {
      console.log(`  skipped ${reason}: ${list.length}`);
      for (const s of list.slice(0, 50)) console.log(`    ${s.id}  [${s.collection}]${reason === 'embedding_dimension' ? `  dims=${s.dims}` : ''}`);
      if (list.length > 50) console.log(`    ... ${list.length - 50} more`);
    }
    if (warnings.length) {
      console.log(`  warnings (copied anyway): ${warnings.length}`);
      for (const w of warnings.slice(0, 50)) console.log(`    ${w}`);
    }
    printCounts('eligible rows per collection', expected.byCollection);
    printCounts('eligible rows per origin_user', expected.byUser);

    if (userMap) await seedUsers(target, new Set(expected.byUser.keys()), userMap, opts.dryRun || opts.verifyOnly);

    if (opts.dryRun) {
      if (target) {
        const t = await targetAggregates(target);
        const missing = [...expected.ids].filter(id => !t.ids.has(id)).length;
        console.log(`\ntarget now: ${t.total} row(s); would insert ${missing}, would upsert ${expected.total - missing} existing`);
      }
      console.log('\ndry run: nothing written');
      return 0;
    }

    // ------------------------------------------------------------ verify
    const failures = [];
    const t = await targetAggregates(target);
    if (t.total !== expected.total) failures.push(`total: source ${expected.total}, target ${t.total}`);
    diffMaps('collection', expected.byCollection, t.byCollection, failures);
    diffMaps('origin_user', expected.byUser, t.byUser, failures);
    if (t.localOnly) failures.push(`target holds ${t.localOnly} local-only row(s)`);
    if (t.badDims) failures.push(`target holds ${t.badDims} row(s) with non-${DIMS} embeddings`);
    const missing = [...expected.ids].filter(id => !t.ids.has(id));
    const extra = [...t.ids].filter(id => !expected.ids.has(id));
    if (missing.length) failures.push(`missing on target: ${missing.length} (e.g. ${missing.slice(0, 5).join(', ')})`);
    if (extra.length) failures.push(`extra on target (deleted on source since an earlier run?): ${extra.length} (e.g. ${extra.slice(0, 5).join(', ')})`);
    const sample = pickSample(expected.ids, opts.sample);
    const sampleOk = await verifySample(source, target, sample, failures);

    console.log('\n=== summary ===');
    console.log(`copied/upserted this run: ${written}`);
    console.log(`source eligible: ${expected.total}  target: ${t.total}`);
    console.log(`collections: ${expected.byCollection.size}  origin_users: ${expected.byUser.size}`);
    console.log(`skipped: ${[...skipped].map(([r, l]) => `${r}=${l.length}`).join(', ') || 'none'}`);
    console.log(`sample rows identical: ${sampleOk}/${sample.length}`);
    if (failures.length) {
      console.log(`VERIFY FAILED (${failures.length}):`);
      for (const f of failures.slice(0, 100)) console.log(`  - ${f}`);
      return 1;
    }
    console.log('VERIFY OK');
    return 0;
  } finally {
    await source.query('ROLLBACK').catch(() => {});
    await source.end().catch(() => {});
    if (target) await target.end().catch(() => {});
  }
}

main().then(
  code => { process.exitCode = code; },
  err => {
    console.error(`error: ${err.message}`);
    process.exitCode = 2;
  },
);
