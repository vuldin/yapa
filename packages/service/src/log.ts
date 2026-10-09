/**
 * Structured JSON logging to stdout (Cloud Logging parses `severity`,
 * `message` and `httpRequest`). Callers pass an allowlist of fields; content,
 * embeddings, metadata values and tokens are never logged.
 */

export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export type LogSink = (line: string) => void;

let sink: LogSink = line => process.stdout.write(line + '\n');

/** Test hook: capture log lines. Returns a function that restores stdout. */
export function setLogSink(next: LogSink): () => void {
  const prev = sink;
  sink = next;
  return () => { sink = prev; };
}

export function log(severity: Severity, message: string, fields: Record<string, unknown> = {}): void {
  sink(JSON.stringify({ severity, message, time: new Date().toISOString(), ...fields }));
}

export interface AuditLine {
  actor: string;
  actor_email: string;
  device: string | null;
  request_id: string;
  action: string;
  doc_id: string;
  collection: string;
  row_owner: string;
  change_class: 'own' | 'teammate';
  prev_collection?: string | null;
  prev_editor?: string | null;
}

/** One line per audited write, mirroring the audit_log row. */
export function logAudit(a: AuditLine): void {
  log('INFO', 'audit', { audit: a });
}
