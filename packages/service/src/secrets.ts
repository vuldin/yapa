/**
 * Secret-pattern check (decision 8): content that looks like a credential is
 * rejected with `secret_detected` and stays in the submitter's local store.
 *
 * Kept deliberately conservative: a false positive blocks a doc from syncing,
 * so every pattern needs a distinctive shape (a known key prefix, a PEM
 * header, a URL with an inline password, or a long high-entropy value
 * assigned to a credential-named key). Placeholders such as `<password>`,
 * `${PG_PASS}` or `changeme` are not secrets.
 *
 * Dependency-free so the client (josh-312) can run the same check before
 * pushing. Only the pattern NAME is ever reported or logged, never the match.
 */

export interface SecretFinding {
  pattern: string;
}

const PLACEHOLDER = /^(?:<[^>]*>|\[[^\]]*\]|\{[^}]*\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|\*+|x+|\.{3,}|_+|-+|password|passwd|pass|pwd|secret|token|changeme|redacted|example|your[-_a-z]*|my[-_a-z]*|placeholder|none|null|undefined)$/i;

export function isPlaceholder(v: string): boolean {
  return PLACEHOLDER.test(v);
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClasses(s: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(s)).length;
}

/** A value that looks machine-generated rather than a word, path or sentence fragment. */
export function looksRandom(v: string): boolean {
  if (v.length < 16 || isPlaceholder(v)) return false;
  if (/^[a-z]+(?:[-_.][a-z]+)*$/i.test(v)) return false; // words joined by separators
  if (/^\/|^https?:\/\//i.test(v)) return false; // paths and plain URLs
  return shannonEntropy(v) >= 3.5 && charClasses(v) >= 2;
}

interface Rule {
  name: string;
  re: RegExp;
  /** Optional extra check on the first capture group. */
  check?: (captured: string) => boolean;
}

const RULES: Rule[] = [
  { name: 'private_key_block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'aws_access_key_id', re: /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/ },
  {
    name: 'aws_secret_access_key',
    re: /aws_?secret_?(?:access_?)?key\s*["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/i,
  },
  {
    name: 'database_url_with_password',
    // scheme://user:password@host for postgres and other common databases.
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:@/]+:([^\s@/]+)@[^\s/]/i,
    check: pw => !isPlaceholder(decodeURIComponentSafe(pw)),
  },
  { name: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'anthropic_api_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'openai_api_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'stripe_secret_key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/ },
  {
    name: 'credential_assignment',
    // password=..., token: "...", api_key = ..., client_secret=... with a
    // long, random-looking value.
    re: /\b(?:password|passwd|pwd|secret|client_secret|token|access_token|auth_token|refresh_token|api_?key|apikey)\s*["']?\s*[:=]\s*["']?([^\s"'`,;&]{16,})/gi,
    check: looksRandom,
  },
];

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** First secret pattern found in `text`, or undefined. */
export function detectSecret(text: string): SecretFinding | undefined {
  if (!text) return undefined;
  for (const rule of RULES) {
    if (rule.re.global) {
      rule.re.lastIndex = 0;
      for (const m of text.matchAll(rule.re)) {
        if (!rule.check || rule.check(m[1] ?? '')) return { pattern: rule.name };
      }
    } else {
      const m = rule.re.exec(text);
      if (m && (!rule.check || rule.check(m[1] ?? ''))) return { pattern: rule.name };
    }
  }
  return undefined;
}

/** Check content plus every string value in metadata (titles and descriptions live there for tasks). */
export function detectSecretInDoc(content: string, metadata: Record<string, unknown>): SecretFinding | undefined {
  const hit = detectSecret(content);
  if (hit) return hit;
  const stack: unknown[] = [metadata];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      const h = detectSecret(v);
      if (h) return h;
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (v && typeof v === 'object') {
      stack.push(...Object.values(v));
    }
  }
  return undefined;
}
