import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ARTIFACTS_DIR } from '../config.js';

export type AdapterStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'promoted' | 'demoted';

export interface AdapterRegistryEntry {
  id: string;
  manifestVersion: number;
  datasetPath: string;
  previewRef: string;
  baseModel: string;
  backend: string;
  backendJobId?: string;
  outputModelRef?: string;
  status: AdapterStatus;
  createdAt: number;
  updatedAt: number;
  evalScore?: number;
  promoted?: boolean;
  notes?: string;
  error?: string;
}

export interface RegistryFile {
  version: number;
  adapters: AdapterRegistryEntry[];
}

function registryPath(): string {
  return join(ARTIFACTS_DIR, 'adapters', 'registry.json');
}

function ensureDir(): void {
  const dir = join(ARTIFACTS_DIR, 'adapters');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): RegistryFile {
  ensureDir();
  const path = registryPath();
  if (!existsSync(path)) return { version: 1, adapters: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.adapters)) {
      return { version: 1, adapters: [] };
    }
    return parsed as RegistryFile;
  } catch {
    return { version: 1, adapters: [] };
  }
}

function save(file: RegistryFile): void {
  ensureDir();
  writeFileSync(registryPath(), JSON.stringify(file, null, 2) + '\n');
}

export function addAdapter(entry: AdapterRegistryEntry): AdapterRegistryEntry {
  const file = load();
  file.adapters.push(entry);
  save(file);
  return entry;
}

export function getAdapter(id: string): AdapterRegistryEntry | null {
  const file = load();
  return file.adapters.find(a => a.id === id) ?? null;
}

export function listAdapters(): AdapterRegistryEntry[] {
  return load().adapters;
}

export function updateAdapter(
  id: string,
  updates: Partial<AdapterRegistryEntry>,
): AdapterRegistryEntry | null {
  const file = load();
  const idx = file.adapters.findIndex(a => a.id === id);
  if (idx === -1) return null;
  const merged: AdapterRegistryEntry = {
    ...file.adapters[idx],
    ...updates,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  file.adapters[idx] = merged;
  save(file);
  return merged;
}

export function getRegistryPath(): string {
  return registryPath();
}
