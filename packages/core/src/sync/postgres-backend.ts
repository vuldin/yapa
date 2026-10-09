/**
 * Advanced/self-host sync target: a direct PostgreSQL+pgvector connection
 * (YAPA_SYNC_DATABASE_URL). Behavior is the pre-service sync: no server-side
 * authorization, no deletions feed, one pull page per collection.
 */
import { getConfig } from '../config.js';
import { getDeviceId } from './device.js';
import {
  addRemoteRelatedIds, checkRemoteHealth, closePool, deleteRemoteDocuments, findSimilarRemote, getRemoteCollections,
  getRemoteCollectionsByIds, getRemoteCollectionsForUser, getRemoteCreatedAt, getRemoteDocsSince, getRemoteMaxTaskNumber,
  getRemoteOwnersByIds, getSyncTlsMode, upsertRemoteDocument,
} from './postgres.js';
import { ensureVectorIndex, migrateSchema } from './schema.js';
import type { PullPage, PullRequest, RemoteOwner, SimilarMatch, SyncBackend, UpsertDoc, UpsertOutcome } from './backend.js';

const TLS_LABEL = {
  'verify-ca': 'encrypted, server verified',
  unverified: 'encrypted, server NOT verified (set sync_ca_cert)',
  off: 'off (local database)',
} as const;

export class PostgresBackend implements SyncBackend {
  readonly kind = 'postgres' as const;
  readonly capabilities = { deletionsFeed: false };

  get target(): string {
    return getConfig().SYNC_DATABASE_URL.replace(/:[^:@/]*@/, ':***@');
  }

  async pull(collection: string, req: PullRequest): Promise<PullPage> {
    const documents = await getRemoteDocsSince(
      collection,
      req.since,
      { user: getConfig().USERNAME, device: getDeviceId() },
      { includeOwnDevice: req.includeOwnDevice },
    );
    return { documents, deletions: [], hasMore: false };
  }

  async upsertMany(docs: UpsertDoc[]): Promise<UpsertOutcome[]> {
    const out: UpsertOutcome[] = [];
    for (const doc of docs) out.push(await this.upsertOne(doc));
    return out;
  }

  /**
   * Same checks the service makes, done client-side: a task id that already
   * belongs to a different task (creation time more than 1 s away) is not
   * overwritten but reported as `id_taken`; similar rows come back for linking.
   */
  private async upsertOne(doc: UpsertDoc): Promise<UpsertOutcome> {
    const me = getConfig().USERNAME;
    if (doc.metadata.type === 'task') {
      const localCreated = Number(doc.metadata.created_at);
      if (Number.isFinite(localCreated) && localCreated > 0) {
        const remoteCreated = await getRemoteCreatedAt(doc.id);
        if (remoteCreated !== undefined && Math.abs(remoteCreated - localCreated) > 1) {
          const max = await getRemoteMaxTaskNumber(me);
          return { id: doc.id, ok: false, code: 'id_taken', message: 'this task id belongs to a different task', permanent: false, suggestedId: `${me}-${max + 1}` };
        }
      }
    }
    // A re-push of an edited doc matches its own remote row; never self-link.
    const similar = doc.embedding.length > 0
      ? (await findSimilarRemote(doc.collection, doc.embedding)).filter(s => s.id !== doc.id)
      : [];
    await upsertRemoteDocument(doc);
    return { id: doc.id, ok: true, status: 'updated', similar };
  }

  delete(ids: string[]): Promise<number> {
    return deleteRemoteDocuments(ids, getConfig().USERNAME);
  }

  collections() {
    return getRemoteCollections();
  }

  collectionsForUser(): Promise<string[]> {
    return getRemoteCollectionsForUser(getConfig().USERNAME);
  }

  collectionsByIds(ids: string[]): Promise<Map<string, string>> {
    return getRemoteCollectionsByIds(ids);
  }

  ownersByIds(ids: string[]): Promise<Map<string, RemoteOwner>> {
    return getRemoteOwnersByIds(ids);
  }

  createdAt(id: string): Promise<number | undefined> {
    return getRemoteCreatedAt(id);
  }

  maxTaskNumber(): Promise<number> {
    return getRemoteMaxTaskNumber(getConfig().USERNAME);
  }

  similar(collection: string, embedding: number[], threshold?: number): Promise<SimilarMatch[]> {
    return findSimilarRemote(collection, embedding, threshold);
  }

  addRelatedIds(id: string, add: string[]): Promise<void> {
    return addRemoteRelatedIds(id, add);
  }

  health() {
    return checkRemoteHealth();
  }

  async prepare(): Promise<void> {
    const h = await checkRemoteHealth();
    if (!h.ok) await migrateSchema();
  }

  maintain(): Promise<void> {
    return ensureVectorIndex();
  }

  async describe(): Promise<string[]> {
    const lines = ['Backend: direct database (advanced/self-host)', `Remote: ${this.target}`];
    try {
      const health = await checkRemoteHealth();
      lines.push(`Connection: ${health.ok ? 'healthy' : `error - ${health.error}`}`);
      lines.push(`TLS: ${TLS_LABEL[getSyncTlsMode()]}`);
    } catch (e) {
      lines.push(`Connection: error - ${e instanceof Error ? e.message : e}`);
    }
    return lines;
  }

  close(): Promise<void> {
    return closePool();
  }
}
