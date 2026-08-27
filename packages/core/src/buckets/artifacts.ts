import { getConfig } from '../config.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';


export type ArtifactKind = 'system-prompt-companion' | 'training-manifests' | 'routing-decisions';

export function artifactDir(kind: ArtifactKind): string {
  return join(getConfig().ARTIFACTS_DIR, kind);
}

export function ensureArtifactDir(kind: ArtifactKind): string {
  const dir = artifactDir(kind);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Return the next available version number for the given artifact kind. */
export function nextVersion(kind: ArtifactKind): number {
  const dir = ensureArtifactDir(kind);
  const files = readdirSync(dir);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^v(\d+)\./);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/** List all existing versions for a kind, ascending. */
export function listVersions(kind: ArtifactKind): number[] {
  const dir = artifactDir(kind);
  if (!existsSync(dir)) return [];
  const versions = new Set<number>();
  for (const f of readdirSync(dir)) {
    const m = f.match(/^v(\d+)\./);
    if (m) versions.add(parseInt(m[1], 10));
  }
  return [...versions].sort((a, b) => a - b);
}

export function writeArtifact(kind: ArtifactKind, filename: string, content: string): string {
  const dir = ensureArtifactDir(kind);
  const path = join(dir, filename);
  writeFileSync(path, content);
  return path;
}

export function readArtifact(kind: ArtifactKind, filename: string): string | null {
  const path = join(artifactDir(kind), filename);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

export function artifactPath(kind: ArtifactKind, filename: string): string {
  return join(artifactDir(kind), filename);
}
