import { unsafeWindow } from '$';
import Dexie, { IndexableType, KeyPaths, Table } from 'dexie';
import { exportDB, importInto } from 'dexie-export-import';

import {
  ImportedBundle,
  ImportedBundleCollection,
  ImportedBundleImportReport,
  ImportedBundleItem,
  ImportedEntitySnapshot,
  projectImportedSnapshot,
} from '@/core/bundles';
import { Capture, SocialEdge, Tweet, User } from '@/types';
import { extractTweetCreatedAtMs, extractTweetMedia } from '@/utils/api';
import { parseTwitterDateTime } from '@/utils/common';
import { migration_20250609 } from '@/utils/migration';
import { enrichUsersWithRelationshipFields } from '@/utils/social-edges';
import { nowMs, recordPerfMetric } from '@/core/perf/metrics';
import logger from '@/utils/logger';
import { ExtensionType } from '../extensions';
import { options } from '../options';
import { emitDatabaseMutation } from './mutation';

// Keep the original database name permanently. Scrollmark is a rebrand, not a data reset:
// deriving this from package.json.name would strand existing captures in the legacy DB.
const DB_NAME = 'twitter-web-exporter';
const DB_VERSION = 6;
const CAPTURE_COUNT_SNAPSHOT_KEY = '__twe_capture_counts_v1';
const CAPTURE_COUNT_SNAPSHOT_V2_KEY = '__twe_capture_counts_v2';
const ACTIVE_DB_NAME_KEY = '__twe_active_db_name_v1';
const CAPTURE_COUNT_EVENT_NAME = 'twe:capture-count-updated-v1';
const DB_WRITE_CHUNK_SIZE = 500;

const BOOKMARK_CONTEXT_FIELDS = [
  '__bookmark_folder_id',
  '__bookmark_folder_name',
  '__bookmark_folder_name_source',
  '__bookmark_folder_url',
] as const;

interface BookmarkFolderNameBackfillOptions {
  candidateTweetIds?: string[];
  candidateLimit?: number;
  recentCaptureScanLimit?: number;
}

interface BookmarkFolderNameBackfillSummary {
  candidates: number;
  inspected: number;
  updated: number;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length <= size) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export interface SearchDocumentRow {
  id: string;
  source_key: string;
  source_kind: 'live' | 'bundle';
  entity_type: 'tweet' | 'user' | 'bundle_item';
  entity_id: string;
  extension_name?: string;
  bundle_id?: string;
  bundle_item_id?: string;
  updated_at_ms: number;
  created_at_ms?: number;
  observed_at_ms?: number;
  primary_text: string;
  quoted_text?: string;
  auxiliary_text?: string;
  author_screen_name?: string;
  author_id?: string;
  folder_id?: string;
  folder_name?: string;
  route_type?: string;
  lang?: string;
  flags_json?: Record<string, boolean>;
  exact_json?: Record<string, string | string[]>;
  numeric_json?: Record<string, number>;
  raw_ref_table: 'tweets' | 'users' | 'imported_entity_snapshots';
  raw_ref_key: string;
  doc_hash: string;
}

function readPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asSearchText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function simpleHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function uniqText(values: string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].join(' ');
}

function mergeTweetMetadata(existing: unknown, incoming: Tweet): Tweet {
  if (!existing || typeof existing !== 'object') {
    return incoming;
  }

  const merged = { ...incoming } as unknown as Record<string, unknown>;
  const existingObj = existing as unknown as Record<string, unknown>;

  for (const field of BOOKMARK_CONTEXT_FIELDS) {
    const existingValue = existingObj[field];
    const incomingValue = (incoming as unknown as Record<string, unknown>)[field];

    if (incomingValue === undefined && existingValue !== undefined) {
      merged[field] = existingValue;
      continue;
    }

    if (incomingValue === null && existingValue !== undefined && existingValue !== null) {
      merged[field] = existingValue;
      continue;
    }

    if (field === '__bookmark_folder_name_source') {
      const incomingSource = String(incomingValue || '');
      const existingSource = String(existingValue || '');
      if (incomingSource === 'id-only' && existingSource === 'api') {
        merged[field] = existingSource;
      }
    }
  }

  return merged as unknown as Tweet;
}

declare global {
  interface Window {
    __META_DATA__: {
      userId: string;
      userHash: string;
    };
  }
}

export class DatabaseManager {
  private db: Dexie;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    let userId = 'unknown';
    try {
      const globalObject = (unsafeWindow ??
        (typeof window !== 'undefined' ? window : undefined) ??
        globalThis) as typeof globalThis & {
        __META_DATA__?: { userId?: string };
      };
      userId = globalObject.__META_DATA__?.userId ?? 'unknown';
    } catch {
      userId = 'unknown';
    }
    const suffix = options.get('dedicatedDbForAccounts') ? `_${userId}` : '';
    logger.debug(`Using database: ${DB_NAME}${suffix} for userId: ${userId}`);

    this.db = new Dexie(`${DB_NAME}${suffix}`);
    this.publishActiveDatabaseName();
    this.init();
  }

  private enqueueWrite<T>(operation: string, write: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(write, write);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch((error) => {
      this.logError(error, operation);
      throw error;
    });
  }

  /*
  |--------------------------------------------------------------------------
  | Type-Safe Table Accessors
  |--------------------------------------------------------------------------
  */

  private tweets() {
    return this.db.table<Tweet>('tweets');
  }

  private users() {
    return this.db.table<User>('users');
  }

  private captures() {
    return this.db.table<Capture>('captures');
  }

  private socialEdges() {
    return this.db.table<SocialEdge>('social_edges');
  }

  private importedBundles() {
    return this.db.table<ImportedBundle>('imported_bundles');
  }

  private importedBundleCollections() {
    return this.db.table<ImportedBundleCollection>('imported_bundle_collections');
  }

  private importedBundleItems() {
    return this.db.table<ImportedBundleItem>('imported_bundle_items');
  }

  private importedEntitySnapshots() {
    return this.db.table<ImportedEntitySnapshot>('imported_entity_snapshots');
  }

  private importedBundleImportReports() {
    return this.db.table<ImportedBundleImportReport>('imported_bundle_import_reports');
  }

  private searchDocuments() {
    return this.db.table<SearchDocumentRow>('search_documents');
  }

  /*
  |--------------------------------------------------------------------------
  | Read Methods for Extensions
  |--------------------------------------------------------------------------
  */

  async extGetCaptures(extName: string) {
    return this.captures().where('extension').equals(extName).toArray().catch(this.logError);
  }

  async extGetCaptureCount(extName: string, type?: ExtensionType) {
    if (type) {
      return this.captures()
        .where('[extension+type]')
        .equals([extName, type])
        .count()
        .catch(this.logError);
    }
    return this.captures().where('extension').equals(extName).count().catch(this.logError);
  }

  async extGetCaptureDataKeys(extName: string) {
    const captures = await this.extGetCaptures(extName);
    if (!captures) {
      return [];
    }
    return this.normalizeDataKeys(captures.map((capture) => capture.data_key));
  }

  async extGetCapturePage(
    extName: string,
    args: {
      type?: ExtensionType;
      offset?: number;
      limit?: number;
      order?: 'newest' | 'oldest';
    } = {},
  ) {
    const startedAt = nowMs();
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
    let collection = args.type
      ? this.captures()
          .where('[extension+type+created_at]')
          .between([extName, args.type, Dexie.minKey], [extName, args.type, Dexie.maxKey])
      : this.captures().where('extension').equals(extName);
    if (args.order !== 'oldest') {
      collection = collection.reverse();
    }
    let rows = await collection.offset(offset).limit(limit).toArray().catch(this.logError);
    rows ||= [];
    if (args.type && !rows.every((capture) => capture.type === args.type)) {
      rows = rows.filter((capture) => capture.type === args.type);
    }
    const result = rows.slice(0, limit);
    recordPerfMetric({
      kind: 'db',
      name: 'capture-page',
      durationMs: nowMs() - startedAt,
      value: result.length,
      tags: { extName, type: args.type, offset, limit },
    });
    return result;
  }

  async extGetCaptureIdsPage(
    extName: string,
    args: {
      type?: ExtensionType;
      offset?: number;
      limit?: number;
      order?: 'newest' | 'oldest';
    } = {},
  ) {
    const rows = await this.extGetCapturePage(extName, args);
    return this.normalizeDataKeys(rows.map((capture) => capture.data_key));
  }

  async extGetTweetsByIds(tweetIds: string[]) {
    const startedAt = nowMs();
    const ids = this.normalizeDataKeys(tweetIds);
    if (!ids.length) {
      return [];
    }
    return this.tweets()
      .bulkGet(ids)
      .then((rows) => {
        const result = rows.filter((row): row is Tweet => !!row && this.filterEmptyData(row));
        recordPerfMetric({
          kind: 'db',
          name: 'tweets-by-ids',
          durationMs: nowMs() - startedAt,
          value: result.length,
          tags: { requested: ids.length },
        });
        return result;
      })
      .catch(this.logError);
  }

  async extGetUsersByIds(userIds: string[]) {
    const startedAt = nowMs();
    const ids = this.normalizeDataKeys(userIds);
    if (!ids.length) {
      return [];
    }
    return this.users()
      .bulkGet(ids)
      .then((rows) => {
        const result = rows.filter((row): row is User => !!row && this.filterEmptyData(row));
        recordPerfMetric({
          kind: 'db',
          name: 'users-by-ids',
          durationMs: nowMs() - startedAt,
          value: result.length,
          tags: { requested: ids.length },
        });
        return result;
      })
      .catch(this.logError);
  }

  async extGetCapturedTweets(extName: string, capturesOverride?: Capture[]) {
    const captures = capturesOverride ?? (await this.extGetCaptures(extName));
    if (!captures) {
      return [];
    }
    return this.extGetTweetsByIds(captures.map((capture) => capture.data_key));
  }

  async extGetCapturedUsers(extName: string, capturesOverride?: Capture[]) {
    const captures = capturesOverride ?? (await this.extGetCaptures(extName));
    if (!captures) {
      return [];
    }
    const users = (await this.extGetUsersByIds(captures.map((capture) => capture.data_key))) ?? [];
    return this.enrichUsersWithRelationshipContext(extName, users);
  }

  async extGetSocialEdges(extName: string) {
    return this.socialEdges().where('extension').equals(extName).toArray().catch(this.logError);
  }

  async extGetSearchDocuments(extName: string, type?: ExtensionType) {
    const startedAt = nowMs();
    const entityType =
      type === ExtensionType.USER ? 'user' : type === ExtensionType.TWEET ? 'tweet' : '';
    const rows =
      type && entityType
        ? await this.searchDocuments()
            .where('[extension_name+entity_type]')
            .equals([extName, entityType])
            .toArray()
            .catch(this.logError)
        : await this.searchDocuments()
            .where('extension_name')
            .equals(extName)
            .toArray()
            .catch(this.logError);
    const result = rows ?? [];
    recordPerfMetric({
      kind: 'db',
      name: 'search-documents',
      durationMs: nowMs() - startedAt,
      value: result.length,
      tags: { extName, type },
    });
    return result;
  }

  async searchDocumentsForSource(sourceKey: string, entityType?: SearchDocumentRow['entity_type']) {
    const rows = await this.searchDocuments()
      .where('source_key')
      .equals(sourceKey)
      .toArray()
      .catch(this.logError);
    if (!rows) return [];
    return entityType ? rows.filter((row) => row.entity_type === entityType) : rows;
  }

  async bundleList() {
    return this.importedBundles().orderBy('updatedAt').reverse().toArray().catch(this.logError);
  }

  async bundleGet(bundleId: string) {
    return this.importedBundles().get(bundleId).catch(this.logError);
  }

  async bundleGetCollections(bundleId: string) {
    return this.importedBundleCollections()
      .where('bundle_id')
      .equals(bundleId)
      .toArray()
      .catch(this.logError);
  }

  async bundleGetItems(bundleId: string, limit = 5000) {
    return this.importedBundleItems()
      .where('bundle_id')
      .equals(bundleId)
      .limit(limit)
      .toArray()
      .catch(this.logError);
  }

  async bundleGetSnapshots(bundleId: string, limit = 5000) {
    return this.importedEntitySnapshots()
      .where('bundle_id')
      .equals(bundleId)
      .limit(limit)
      .toArray()
      .catch(this.logError);
  }

  async bundleGetSnapshotCount(bundleId: string, kind?: ImportedEntitySnapshot['kind']) {
    if (kind) {
      return this.importedEntitySnapshots()
        .where('[bundle_id+kind]')
        .equals([bundleId, kind])
        .count()
        .catch(this.logError);
    }
    return this.importedEntitySnapshots()
      .where('bundle_id')
      .equals(bundleId)
      .count()
      .catch(this.logError);
  }

  async bundleGetSnapshotPage(
    bundleId: string,
    args: {
      kind?: ImportedEntitySnapshot['kind'];
      offset?: number;
      limit?: number;
      order?: 'newest' | 'oldest';
    } = {},
  ) {
    const offset = Math.max(0, Number(args.offset || 0));
    const limit = Math.max(1, Number(args.limit || 5000));
    const rows = args.kind
      ? await this.importedEntitySnapshots()
          .where('[bundle_id+kind]')
          .equals([bundleId, args.kind])
          .toArray()
          .catch(this.logError)
      : await this.importedEntitySnapshots()
          .where('bundle_id')
          .equals(bundleId)
          .toArray()
          .catch(this.logError);

    return (rows ?? [])
      .sort((left, right) => {
        const leftTime = Number(left.observed_at || left.created_at || left.updated_at || 0);
        const rightTime = Number(right.observed_at || right.created_at || right.updated_at || 0);
        if (leftTime !== rightTime) {
          return args.order === 'oldest' ? leftTime - rightTime : rightTime - leftTime;
        }
        return right.id.localeCompare(left.id);
      })
      .slice(offset, offset + limit);
  }

  async bundleGetSnapshotsByIds(snapshotIds: string[]) {
    const ids = this.normalizeDataKeys(snapshotIds);
    if (!ids.length) return [];
    return this.importedEntitySnapshots()
      .bulkGet(ids)
      .then((rows) => rows.filter((row): row is ImportedEntitySnapshot => !!row))
      .catch(this.logError);
  }

  async bundleSearchSnapshots(bundleId: string, query: string, limit = 5000) {
    const normalized = query.trim().toLowerCase();
    const table = this.importedEntitySnapshots().where('bundle_id').equals(bundleId);
    if (!normalized) {
      return table.limit(limit).toArray().catch(this.logError);
    }
    return table
      .filter((snapshot) =>
        String(snapshot.search_text || '')
          .toLowerCase()
          .includes(normalized),
      )
      .limit(limit)
      .toArray()
      .catch(this.logError);
  }

  /*
  |--------------------------------------------------------------------------
  | Write Methods for Extensions
  |--------------------------------------------------------------------------
  */

  async extAddTweets(extName: string, tweets: Tweet[]) {
    const normalizedTweets = this.normalizeRowsByRestId(tweets);
    if (!normalizedTweets.length) {
      return;
    }

    await this.enqueueWrite('extAddTweets', async () => {
      const now = Date.now();
      const captures = normalizedTweets.map((tweet) => ({
        id: `${extName}-${tweet.rest_id}`,
        extension: extName,
        type: ExtensionType.TWEET,
        data_key: tweet.rest_id,
        created_at: now,
      }));
      const documents = this.buildTweetSearchDocuments(extName, normalizedTweets);

      await this.db.transaction(
        'rw',
        this.tweets(),
        this.captures(),
        this.searchDocuments(),
        async () => {
          await this.putMergedTweets(normalizedTweets);
          await this.bulkPutInChunks(this.captures(), captures);
          await this.bulkPutInChunks(this.searchDocuments(), documents);
        },
      );

      emitDatabaseMutation({
        extension: extName,
        operation: 'extAddTweets',
        count: normalizedTweets.length,
        keys: normalizedTweets.map((tweet) => tweet.rest_id),
      });
      void this.publishCaptureCountSnapshot(extName);
    });
  }

  async extAddUsers(extName: string, users: User[]) {
    const normalizedUsers = this.normalizeRowsByRestId(users);
    if (!normalizedUsers.length) {
      return;
    }

    await this.enqueueWrite('extAddUsers', async () => {
      const now = Date.now();
      const captures = normalizedUsers.map((user) => ({
        id: `${extName}-${user.rest_id}`,
        extension: extName,
        type: ExtensionType.USER,
        data_key: user.rest_id,
        created_at: now,
      }));
      const documents = this.buildUserSearchDocuments(extName, normalizedUsers);

      await this.db.transaction(
        'rw',
        this.users(),
        this.captures(),
        this.searchDocuments(),
        async () => {
          await this.putUsers(normalizedUsers);
          await this.bulkPutInChunks(this.captures(), captures);
          await this.bulkPutInChunks(this.searchDocuments(), documents);
        },
      );

      emitDatabaseMutation({
        extension: extName,
        operation: 'extAddUsers',
        count: normalizedUsers.length,
        keys: normalizedUsers.map((user) => user.rest_id),
      });
      void this.publishCaptureCountSnapshot(extName);
    });
  }

  async extAddCustomCaptures(
    extName: string,
    items: Array<{ id: string; data_key: string; created_at?: number }>,
  ) {
    if (!items.length) {
      return;
    }

    const captures: Capture[] = [];
    for (const item of items) {
      const id = String(item.id || '').trim();
      const dataKey = String(item.data_key || '').trim();
      if (!id || !dataKey) {
        continue;
      }
      captures.push({
        id: `${extName}-${id}`,
        extension: extName,
        type: ExtensionType.CUSTOM,
        data_key: dataKey,
        created_at: Number(item.created_at) || Date.now(),
      });
    }

    if (!captures.length) {
      return;
    }

    await this.enqueueWrite('extAddCustomCaptures', async () => {
      await this.db.transaction('rw', this.captures(), async () => {
        await this.bulkPutInChunks(this.captures(), captures);
      });
      emitDatabaseMutation({
        extension: extName,
        operation: 'extAddCustomCaptures',
        count: captures.length,
        keys: captures.map((capture) => capture.data_key),
      });
      void this.publishCaptureCountSnapshot(extName);
    });
  }

  async extAddSocialEdges(extName: string, edges: SocialEdge[]) {
    const normalized = edges
      .map((edge) => ({
        ...edge,
        extension: extName,
        observed_at: Number(edge.observed_at) || Date.now(),
      }))
      .filter(
        (edge) => edge.subject_user_id && edge.related_user_id && edge.relation_type && edge.id,
      );

    if (!normalized.length) {
      return;
    }

    await this.enqueueWrite('extAddSocialEdges', async () => {
      await this.db.transaction('rw', this.socialEdges(), async () => {
        await this.bulkPutInChunks(this.socialEdges(), normalized);
      });
      emitDatabaseMutation({
        extension: extName,
        operation: 'extAddSocialEdges',
        count: normalized.length,
        keys: normalized.map((edge) => edge.id),
      });
    });
  }

  async extAddTweetCaptureIds(
    extName: string,
    tweetIds: string[],
    mutateExisting?: (tweet: Tweet) => Tweet,
  ) {
    const ids = this.normalizeDataKeys(tweetIds);
    if (!ids.length) {
      return;
    }

    await this.enqueueWrite('extAddTweetCaptureIds', async () => {
      await this.db.transaction(
        'rw',
        this.tweets(),
        this.captures(),
        this.searchDocuments(),
        async () => {
          const existingRows: Tweet[] = [];
          for (const chunk of chunkArray(ids, DB_WRITE_CHUNK_SIZE)) {
            existingRows.push(...(await this.tweets().where('rest_id').anyOf(chunk).toArray()));
          }

          if (mutateExisting && existingRows.length) {
            await this.bulkPutInChunks(
              this.tweets(),
              existingRows.map((row) => mutateExisting(row)),
            );
          }

          await this.bulkPutInChunks(
            this.captures(),
            ids.map((tweetId) => ({
              id: `${extName}-${tweetId}`,
              extension: extName,
              type: ExtensionType.TWEET,
              data_key: tweetId,
              created_at: Date.now(),
            })),
          );
          await this.bulkPutInChunks(
            this.searchDocuments(),
            this.buildTweetSearchDocuments(extName, existingRows),
          );

          emitDatabaseMutation({
            extension: extName,
            operation: 'extAddTweetCaptureIds',
            count: ids.length,
            keys: ids,
          });
          void this.publishCaptureCountSnapshot(extName);
        },
      );
    });
  }

  async extBackfillTweetCapturesFromAllTweets(extName: string) {
    const existingCount = await this.extGetCaptureCount(extName);
    if (existingCount) {
      return;
    }

    const keys = await this.tweets()
      .toCollection()
      .primaryKeys()
      .then((items) => items.map((item) => String(item || '')).filter(Boolean))
      .catch(this.logError);

    if (!keys?.length) {
      return;
    }

    await this.extAddTweetCaptureIds(extName, keys);
  }

  async extRemoveTweetCaptureIds(
    extName: string,
    tweetIds: string[],
    mutateExisting?: (tweet: Tweet) => Tweet,
  ) {
    const ids = this.normalizeDataKeys(tweetIds);
    if (!ids.length) {
      return;
    }

    await this.db
      .transaction('rw', this.tweets(), this.captures(), this.searchDocuments(), async () => {
        if (mutateExisting) {
          const existingRows = await this.tweets().where('rest_id').anyOf(ids).toArray();
          if (existingRows.length) {
            await this.tweets().bulkPut(existingRows.map((row) => mutateExisting(row)));
          }
        }

        await this.captures().bulkDelete(ids.map((tweetId) => `${extName}-${tweetId}`));
        await this.searchDocuments().bulkDelete(
          ids.map((tweetId) => `live:${extName}:tweet:${tweetId}`),
        );
      })
      .catch(this.logError);

    emitDatabaseMutation({
      extension: extName,
      operation: 'extRemoveTweetCaptureIds',
      count: ids.length,
      keys: ids,
    });
    void this.publishCaptureCountSnapshot(extName);
  }

  async extAddUserCaptureIds(
    extName: string,
    userIds: string[],
    mutateExisting?: (user: User) => User,
  ) {
    const ids = this.normalizeDataKeys(userIds);
    if (!ids.length) {
      return;
    }

    await this.db
      .transaction('rw', this.users(), this.captures(), this.searchDocuments(), async () => {
        let existingRows: User[] = [];
        if (mutateExisting) {
          existingRows = await this.users().where('rest_id').anyOf(ids).toArray();
          if (existingRows.length) {
            await this.users().bulkPut(existingRows.map((row) => mutateExisting(row)));
          }
        } else {
          existingRows = await this.users().where('rest_id').anyOf(ids).toArray();
        }

        await this.captures().bulkPut(
          ids.map((userId) => ({
            id: `${extName}-${userId}`,
            extension: extName,
            type: ExtensionType.USER,
            data_key: userId,
            created_at: Date.now(),
          })),
        );
        await this.searchDocuments().bulkPut(this.buildUserSearchDocuments(extName, existingRows));
      })
      .catch(this.logError);

    emitDatabaseMutation({
      extension: extName,
      operation: 'extAddUserCaptureIds',
      count: ids.length,
      keys: ids,
    });
    void this.publishCaptureCountSnapshot(extName);
  }

  async extRemoveUserCaptureIds(
    extName: string,
    userIds: string[],
    mutateExisting?: (user: User) => User,
  ) {
    const ids = this.normalizeDataKeys(userIds);
    if (!ids.length) {
      return;
    }

    await this.db
      .transaction('rw', this.users(), this.captures(), this.searchDocuments(), async () => {
        if (mutateExisting) {
          const existingRows = await this.users().where('rest_id').anyOf(ids).toArray();
          if (existingRows.length) {
            await this.users().bulkPut(existingRows.map((row) => mutateExisting(row)));
          }
        }

        await this.captures().bulkDelete(ids.map((userId) => `${extName}-${userId}`));
        await this.searchDocuments().bulkDelete(
          ids.map((userId) => `live:${extName}:user:${userId}`),
        );
      })
      .catch(this.logError);

    emitDatabaseMutation({
      extension: extName,
      operation: 'extRemoveUserCaptureIds',
      count: ids.length,
      keys: ids,
    });
    void this.publishCaptureCountSnapshot(extName);
  }

  async bundlePutImportBatch(args: {
    bundle: ImportedBundle;
    collections?: ImportedBundleCollection[];
    items?: ImportedBundleItem[];
    snapshots?: ImportedEntitySnapshot[];
    report?: ImportedBundleImportReport;
  }) {
    const now = Date.now();
    const bundle = {
      ...args.bundle,
      updatedAt: now,
    };

    await this.db
      .transaction(
        'rw',
        [
          this.importedBundles(),
          this.importedBundleCollections(),
          this.importedBundleItems(),
          this.importedEntitySnapshots(),
          this.importedBundleImportReports(),
          this.searchDocuments(),
        ],
        async () => {
          await this.importedBundles().put(bundle);
          if (args.collections?.length) {
            await this.importedBundleCollections().bulkPut(args.collections);
          }
          if (args.items?.length) {
            await this.importedBundleItems().bulkPut(args.items);
          }
          if (args.snapshots?.length) {
            await this.importedEntitySnapshots().bulkPut(args.snapshots);
            await this.searchDocuments().bulkPut(
              this.buildImportedSnapshotSearchDocuments(bundle.id, args.snapshots),
            );
          }
          if (args.report) {
            await this.importedBundleImportReports().put(args.report);
          }
        },
      )
      .catch(this.logError);

    emitDatabaseMutation({
      operation: 'bundlePutImportBatch',
      count: args.snapshots?.length ?? 0,
      keys: [bundle.id],
    });
  }

  async bundleMarkReady(bundleId: string) {
    await this.importedBundles()
      .update(bundleId, {
        status: 'ready',
        updatedAt: Date.now(),
      } satisfies Partial<ImportedBundle>)
      .catch(this.logError);
    emitDatabaseMutation({ operation: 'bundleMarkReady', keys: [bundleId] });
  }

  async bundleMarkFailed(bundleId: string, error: string) {
    await this.importedBundles()
      .update(bundleId, {
        status: 'failed',
        error,
        updatedAt: Date.now(),
      } satisfies Partial<ImportedBundle>)
      .catch(this.logError);
    emitDatabaseMutation({ operation: 'bundleMarkFailed', keys: [bundleId] });
  }

  /*
  |--------------------------------------------------------------------------
  | Delete Methods for Extensions
  |--------------------------------------------------------------------------
  */

  async extClearCaptures(extName: string) {
    const captures = await this.extGetCaptures(extName);
    if (!captures) {
      return;
    }
    const result = await this.db
      .transaction('rw', this.captures(), this.searchDocuments(), async () => {
        const deleted = await this.captures().bulkDelete(captures.map((capture) => capture.id));
        const searchDocIds = captures
          .map((capture) => {
            if (capture.type === ExtensionType.TWEET) {
              return `live:${extName}:tweet:${capture.data_key}`;
            }
            if (capture.type === ExtensionType.USER) {
              return `live:${extName}:user:${capture.data_key}`;
            }
            return '';
          })
          .filter(Boolean);
        if (searchDocIds.length) {
          await this.searchDocuments().bulkDelete(searchDocIds);
        }
        return deleted;
      })
      .catch(this.logError);
    emitDatabaseMutation({
      extension: extName,
      operation: 'extClearCaptures',
      count: captures.length,
      keys: captures.map((capture) => capture.data_key),
    });
    void this.publishCaptureCountSnapshot(extName);
    return result;
  }

  async extBackfillRecentBookmarkFolderName(
    extName: string,
    folderId: string,
    folderName: string,
    options: BookmarkFolderNameBackfillOptions = {},
  ): Promise<BookmarkFolderNameBackfillSummary> {
    if (!extName || !folderId || !folderName) {
      return { candidates: 0, inspected: 0, updated: 0 };
    }

    const candidateLimit = Math.max(1, Math.min(1000, Number(options.candidateLimit) || 250));
    const recentCaptureScanLimit = Math.max(
      100,
      Math.min(5000, Number(options.recentCaptureScanLimit) || 1800),
    );

    const candidateIds = new Set<string>();
    for (const id of options.candidateTweetIds || []) {
      if (typeof id !== 'string') continue;
      const normalized = id.trim();
      if (!normalized) continue;
      candidateIds.add(normalized);
      if (candidateIds.size >= candidateLimit) break;
    }

    if (candidateIds.size < candidateLimit) {
      const recent = await this.captures()
        .orderBy('created_at')
        .reverse()
        .limit(recentCaptureScanLimit)
        .toArray()
        .catch(this.logError);

      for (const row of recent || []) {
        if (row?.extension !== extName || row?.type !== ExtensionType.TWEET) {
          continue;
        }

        const normalized = String(row?.data_key || '').trim();
        if (!normalized || candidateIds.has(normalized)) {
          continue;
        }

        candidateIds.add(normalized);
        if (candidateIds.size >= candidateLimit) {
          break;
        }
      }
    }

    if (!candidateIds.size) {
      return { candidates: 0, inspected: 0, updated: 0 };
    }

    const candidateArray = [...candidateIds];

    return await this.db
      .transaction('rw', this.tweets(), this.searchDocuments(), async () => {
        const rows = await this.tweets().where('rest_id').anyOf(candidateArray).toArray();

        const updates: Tweet[] = [];
        for (const row of rows) {
          const current = row as unknown as Record<string, unknown>;
          if (String(current.__bookmark_folder_id || '') !== folderId) {
            continue;
          }

          const currentName = String(current.__bookmark_folder_name || '');
          const currentSource = String(current.__bookmark_folder_name_source || '');
          if (currentName === folderName && currentSource === 'api') {
            continue;
          }

          updates.push({
            ...row,
            ...({
              __bookmark_folder_name: folderName,
              __bookmark_folder_name_source: 'api',
            } as unknown as Partial<Tweet>),
          } as Tweet);
        }

        if (updates.length) {
          await this.tweets().bulkPut(updates);
          await this.searchDocuments().bulkPut(this.buildTweetSearchDocuments(extName, updates));
          emitDatabaseMutation({
            extension: extName,
            operation: 'bookmarkFolderNameBackfill',
          });
        }

        return {
          candidates: candidateArray.length,
          inspected: rows.length,
          updated: updates.length,
        };
      })
      .catch((error) => {
        this.logError(error);
        return {
          candidates: candidateArray.length,
          inspected: 0,
          updated: 0,
        };
      });
  }

  /*
  |--------------------------------------------------------------------------
  | Export and Import Methods
  |--------------------------------------------------------------------------
  */

  async export() {
    return exportDB(this.db).catch(this.logError);
  }

  async import(data: Blob) {
    const result = await importInto(this.db, data).catch(this.logError);
    emitDatabaseMutation({
      operation: 'import',
    });
    this.publishCaptureCountSnapshotForAllKnownExtensions();
    return result;
  }

  async clear() {
    await this.deleteAllCaptures();
    await this.deleteAllSocialEdges();
    await this.deleteAllSearchDocuments();
    await this.deleteAllTweets();
    await this.deleteAllUsers();
    emitDatabaseMutation({
      operation: 'clear',
    });
    this.publishCaptureCountSnapshotForAllKnownExtensions();
    logger.info('Database cleared');
  }

  async count() {
    try {
      return {
        tweets: await this.tweets().count(),
        users: await this.users().count(),
        captures: await this.captures().count(),
        social_edges: await this.socialEdges().count(),
        imported_bundles: await this.importedBundles().count(),
        imported_entity_snapshots: await this.importedEntitySnapshots().count(),
        search_documents: await this.searchDocuments().count(),
      };
    } catch (error) {
      this.logError(error);
      return null;
    }
  }

  private async publishCaptureCountSnapshot(extName: string): Promise<void> {
    try {
      const count = Number((await this.extGetCaptureCount(extName)) || 0);
      const dbName = this.db.name;
      const updatedAt = Date.now();
      const globalObject = globalThis as Record<string, unknown>;
      const current = globalObject[CAPTURE_COUNT_SNAPSHOT_KEY];
      const map =
        current && typeof current === 'object'
          ? ({ ...(current as Record<string, number>) } as Record<string, number>)
          : ({} as Record<string, number>);
      map[extName] = count;

      const currentV2 = globalObject[CAPTURE_COUNT_SNAPSHOT_V2_KEY];
      const mapV2 =
        currentV2 && typeof currentV2 === 'object'
          ? ({ ...(currentV2 as Record<string, unknown>) } as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      mapV2[extName] = { count, dbName, updatedAt };

      globalObject[CAPTURE_COUNT_SNAPSHOT_KEY] = map;
      globalObject[CAPTURE_COUNT_SNAPSHOT_V2_KEY] = mapV2;
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>)[CAPTURE_COUNT_SNAPSHOT_KEY] = map;
        (window as unknown as Record<string, unknown>)[CAPTURE_COUNT_SNAPSHOT_V2_KEY] = mapV2;
      }

      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(CAPTURE_COUNT_SNAPSHOT_KEY, JSON.stringify(map));
          localStorage.setItem(CAPTURE_COUNT_SNAPSHOT_V2_KEY, JSON.stringify(mapV2));
        }
      } catch {
        // ignore localStorage failures
      }

      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          const detail = {
            extension: extName,
            count,
            dbName,
            updatedAt,
          };
          try {
            window.dispatchEvent(
              new CustomEvent(CAPTURE_COUNT_EVENT_NAME, {
                detail,
              }),
            );
          } catch {
            window.dispatchEvent(new Event(CAPTURE_COUNT_EVENT_NAME));
          }
        }
      } catch {
        // ignore event dispatch failures
      }
    } catch {
      // ignore snapshot failures
    }
  }

  private publishCaptureCountSnapshotForAllKnownExtensions(): void {
    void this.captures()
      .toArray()
      .then((rows) => {
        const set = new Set<string>();
        for (const row of rows) {
          if (row?.extension) {
            set.add(String(row.extension));
          }
        }
        return Promise.all([...set].map((extName) => this.publishCaptureCountSnapshot(extName)));
      })
      .catch(() => {
        // ignore
      });
  }

  private publishActiveDatabaseName(): void {
    try {
      const dbName = this.db.name;
      const globalObject = globalThis as Record<string, unknown>;
      globalObject[ACTIVE_DB_NAME_KEY] = dbName;
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>)[ACTIVE_DB_NAME_KEY] = dbName;
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(ACTIVE_DB_NAME_KEY, dbName);
      }
    } catch {
      // ignore
    }
  }

  /*
  |--------------------------------------------------------------------------
  | Common Methods
  |--------------------------------------------------------------------------
  */

  private buildTweetSearchDocuments(extName: string, tweets: Tweet[]): SearchDocumentRow[] {
    const now = Date.now();
    const rows: SearchDocumentRow[] = [];
    for (const tweet of tweets) {
      const obj = tweet as unknown as Record<string, unknown>;
      const id = String(tweet.rest_id || readPath(obj, 'legacy.id_str') || '').trim();
      if (!id) continue;
      const articleTitle = asSearchText(readPath(obj, 'article.article_results.result.title'));
      const articlePreview = asSearchText(
        readPath(obj, 'article.article_results.result.preview_text'),
      );
      const fullText = uniqText([
        asSearchText(readPath(obj, 'note_tweet.note_tweet_results.result.text')),
        articleTitle,
        articlePreview,
        asSearchText(readPath(obj, 'legacy.full_text')),
        asSearchText(readPath(obj, 'legacy.text')),
      ]);
      const quotedText = uniqText([
        asSearchText(
          readPath(obj, 'quoted_status_result.result.note_tweet.note_tweet_results.result.text'),
        ),
        asSearchText(readPath(obj, 'quoted_status_result.result.legacy.full_text')),
        asSearchText(readPath(obj, 'quoted_status_result.result.legacy.text')),
      ]);
      const authorScreenName = asSearchText(
        readPath(obj, 'core.user_results.result.core.screen_name') ||
          readPath(obj, 'core.screen_name'),
      ).toLowerCase();
      const authorId = asSearchText(
        readPath(obj, 'core.user_results.result.rest_id') || readPath(obj, 'author_id'),
      );
      const folderId = asSearchText(readPath(obj, '__bookmark_folder_id'));
      const folderName = asSearchText(readPath(obj, '__bookmark_folder_name'));
      const createdAtMs = extractTweetCreatedAtMs(tweet);
      const primaryText = uniqText([fullText, authorScreenName, folderId, folderName]);
      const auxiliaryText = uniqText([
        asSearchText(readPath(obj, 'legacy.lang')),
        asSearchText(readPath(obj, 'card.name')),
        asSearchText(readPath(obj, 'card.card_platform.card_name')),
      ]);
      const hasMedia = extractTweetMedia(tweet).length > 0;
      const docHash = simpleHash([primaryText, quotedText, auxiliaryText].join('\n'));
      rows.push({
        id: `live:${extName}:tweet:${id}`,
        source_key: `live:${extName}`,
        source_kind: 'live',
        entity_type: 'tweet',
        entity_id: id,
        extension_name: extName,
        updated_at_ms: now,
        created_at_ms: createdAtMs || undefined,
        observed_at_ms: now,
        primary_text: primaryText,
        quoted_text: quotedText || undefined,
        auxiliary_text: auxiliaryText || undefined,
        author_screen_name: authorScreenName || undefined,
        author_id: authorId || undefined,
        folder_id: folderId || undefined,
        folder_name: folderName || undefined,
        route_type: asSearchText(readPath(obj, '__route_type')) || undefined,
        lang: asSearchText(readPath(obj, 'legacy.lang')) || undefined,
        flags_json: { has_media: hasMedia },
        exact_json: {
          author: authorScreenName ? [authorScreenName, `@${authorScreenName}`] : [],
          folder: [folderId, folderName].filter(Boolean),
        },
        numeric_json: {
          favorite_count: Number(readPath(obj, 'legacy.favorite_count') || 0),
          retweet_count: Number(readPath(obj, 'legacy.retweet_count') || 0),
          reply_count: Number(readPath(obj, 'legacy.reply_count') || 0),
          bookmark_count: Number(readPath(obj, 'legacy.bookmark_count') || 0),
        },
        raw_ref_table: 'tweets',
        raw_ref_key: id,
        doc_hash: docHash,
      });
    }
    return rows;
  }

  private buildUserSearchDocuments(extName: string, users: User[]): SearchDocumentRow[] {
    const now = Date.now();
    const rows: SearchDocumentRow[] = [];
    for (const user of users) {
      const obj = user as unknown as Record<string, unknown>;
      const id = String(user.rest_id || '').trim();
      if (!id) continue;
      const screenName = asSearchText(readPath(obj, 'core.screen_name')).toLowerCase();
      const name = asSearchText(readPath(obj, 'core.name'));
      const description = asSearchText(readPath(obj, 'legacy.description'));
      const primaryText = uniqText([screenName, name, description]);
      rows.push({
        id: `live:${extName}:user:${id}`,
        source_key: `live:${extName}`,
        source_kind: 'live',
        entity_type: 'user',
        entity_id: id,
        extension_name: extName,
        updated_at_ms: now,
        created_at_ms: Number(user.twe_private_fields?.created_at || 0) || undefined,
        observed_at_ms: now,
        primary_text: primaryText,
        author_screen_name: screenName || undefined,
        author_id: id,
        flags_json: {
          is_blue_verified: Boolean(readPath(obj, 'is_blue_verified')),
        },
        exact_json: {
          author: screenName ? [screenName, `@${screenName}`] : [],
        },
        raw_ref_table: 'users',
        raw_ref_key: id,
        doc_hash: simpleHash(primaryText),
      });
    }
    return rows;
  }

  private buildImportedSnapshotSearchDocuments(
    bundleId: string,
    snapshots: ImportedEntitySnapshot[],
  ): SearchDocumentRow[] {
    const now = Date.now();
    return snapshots.map((snapshot) => {
      const data = snapshot.data as Record<string, unknown>;
      const projected =
        snapshot.kind === 'tweet' || snapshot.kind === 'user'
          ? (projectImportedSnapshot(snapshot) as Record<string, unknown>)
          : data;
      const sourceId = String(snapshot.source_id || snapshot.id).trim();
      const searchText = asSearchText(snapshot.search_text) || uniqText([JSON.stringify(data)]);
      const folderId = asSearchText(readPath(projected, '__bookmark_folder_id'));
      const folderName = asSearchText(readPath(projected, '__bookmark_folder_name'));
      return {
        id: `bundle:${bundleId}:${snapshot.kind}:${snapshot.id}`,
        source_key: `bundle:${bundleId}`,
        source_kind: 'bundle',
        entity_type:
          snapshot.kind === 'user' ? 'user' : snapshot.kind === 'tweet' ? 'tweet' : 'bundle_item',
        entity_id: sourceId,
        bundle_id: bundleId,
        bundle_item_id: snapshot.id,
        extension_name: snapshot.source_extension,
        updated_at_ms: now,
        created_at_ms: snapshot.created_at,
        observed_at_ms: snapshot.observed_at,
        primary_text: searchText,
        folder_id: folderId || undefined,
        folder_name: folderName || undefined,
        exact_json: {
          folder: [folderId, folderName].filter(Boolean),
        },
        raw_ref_table: 'imported_entity_snapshots',
        raw_ref_key: snapshot.id,
        doc_hash: simpleHash(searchText),
      } satisfies SearchDocumentRow;
    });
  }

  async upsertSearchDocuments(rows: SearchDocumentRow[]) {
    if (!rows.length) return;
    const startedAt = nowMs();
    return this.enqueueWrite('upsertSearchDocuments', async () => {
      const result = await this.db.transaction('rw', this.searchDocuments(), async () => {
        await this.bulkPutInChunks(this.searchDocuments(), rows);
      });
      recordPerfMetric({
        kind: 'db',
        name: 'search-documents-upsert',
        durationMs: nowMs() - startedAt,
        value: rows.length,
      });
      return result;
    });
  }

  async extBackfillSearchDocuments(extName: string, type: ExtensionType, chunkSize = 640) {
    const startedAt = nowMs();
    const entityType =
      type === ExtensionType.USER ? 'user' : type === ExtensionType.TWEET ? 'tweet' : null;
    if (!entityType) {
      return { processed: 0, documents: 0 };
    }

    let offset = 0;
    let processed = 0;
    let documents = 0;

    while (true) {
      const captures = await this.extGetCapturePage(extName, {
        type,
        offset,
        limit: chunkSize,
        order: 'newest',
      });
      if (!captures.length) break;
      const observedAtByKey = new Map(
        captures.map((capture) => [capture.data_key, Number(capture.created_at) || Date.now()]),
      );

      if (type === ExtensionType.USER) {
        const users = ((await this.extGetCapturedUsers(extName, captures)) ?? []) as User[];
        const rows = this.buildUserSearchDocuments(extName, users);
        rows.forEach((row) => {
          row.observed_at_ms = observedAtByKey.get(row.raw_ref_key) || row.observed_at_ms;
        });
        await this.upsertSearchDocuments(rows);
        documents += rows.length;
      } else {
        const tweets = ((await this.extGetCapturedTweets(extName, captures)) ?? []) as Tweet[];
        const rows = this.buildTweetSearchDocuments(extName, tweets);
        rows.forEach((row) => {
          row.observed_at_ms = observedAtByKey.get(row.raw_ref_key) || row.observed_at_ms;
        });
        await this.upsertSearchDocuments(rows);
        documents += rows.length;
      }

      processed += captures.length;
      offset += captures.length;
      if (captures.length < chunkSize) break;
    }

    recordPerfMetric({
      kind: 'db',
      name: 'search-documents-backfill',
      durationMs: nowMs() - startedAt,
      value: documents,
      tags: { extName, type, processed },
    });
    emitDatabaseMutation({ extension: extName, operation: 'searchDocumentsBackfill' });
    return { processed, documents };
  }

  private async putMergedTweets(tweets: Tweet[]) {
    if (!tweets.length) {
      return;
    }

    const ids = this.normalizeDataKeys(tweets.map((tweet) => tweet.rest_id));
    const existingRows: Tweet[] = [];
    for (const chunk of chunkArray(ids, DB_WRITE_CHUNK_SIZE)) {
      existingRows.push(...(await this.tweets().where('rest_id').anyOf(chunk).toArray()));
    }
    const existingById = new Map(existingRows.map((row) => [String(row.rest_id), row]));

    const data: Tweet[] = tweets.map((tweet) => {
      const normalized = {
        ...tweet,
        twe_private_fields: {
          created_at: extractTweetCreatedAtMs(tweet),
          updated_at: Date.now(),
          media_count: extractTweetMedia(tweet).length,
        },
      };

      return mergeTweetMetadata(existingById.get(tweet.rest_id) ?? null, normalized);
    });

    await this.bulkPutInChunks(this.tweets(), data);
  }

  private async putUsers(users: User[]) {
    if (!users.length) {
      return;
    }

    const data: User[] = users.map((user) => ({
      ...user,
      twe_private_fields: {
        created_at: +parseTwitterDateTime(user.core.created_at),
        updated_at: Date.now(),
      },
    }));

    await this.bulkPutInChunks(this.users(), data);
  }

  private async bulkPutInChunks<T>(table: Table<T, IndexableType>, rows: T[]) {
    for (const chunk of chunkArray(rows, DB_WRITE_CHUNK_SIZE)) {
      await table.bulkPut(chunk);
    }
  }

  private normalizeRowsByRestId<T extends { rest_id?: string }>(rows: T[]): T[] {
    const byId = new Map<string, T>();
    for (const row of rows) {
      const id = String(row?.rest_id || '').trim();
      if (!id) continue;
      byId.set(id, { ...row, rest_id: id });
    }
    return [...byId.values()];
  }

  async upsertTweets(tweets: Tweet[]) {
    const normalizedTweets = this.normalizeRowsByRestId(tweets);
    if (!normalizedTweets.length) {
      return;
    }

    return this.enqueueWrite('upsertTweets', async () => {
      await this.db.transaction('rw', this.tweets(), async () => {
        await this.putMergedTweets(normalizedTweets);
      });
    });
  }

  async upsertUsers(users: User[]) {
    const normalizedUsers = this.normalizeRowsByRestId(users);
    if (!normalizedUsers.length) {
      return;
    }

    return this.enqueueWrite('upsertUsers', async () => {
      await this.db.transaction('rw', this.users(), async () => {
        await this.putUsers(normalizedUsers);
      });
    });
  }

  async upsertCaptures(captures: Capture[]) {
    if (!captures.length) return;
    return this.enqueueWrite('upsertCaptures', async () => {
      await this.db.transaction('rw', this.captures(), async () => {
        await this.bulkPutInChunks(this.captures(), captures);
      });
    });
  }

  async upsertSocialEdges(edges: SocialEdge[]) {
    if (!edges.length) return;
    return this.enqueueWrite('upsertSocialEdges', async () => {
      await this.db.transaction('rw', this.socialEdges(), async () => {
        await this.bulkPutInChunks(this.socialEdges(), edges);
      });
    });
  }

  async deleteAllTweets() {
    return this.tweets().clear().catch(this.logError);
  }

  async deleteAllUsers() {
    return this.users().clear().catch(this.logError);
  }

  async deleteAllCaptures() {
    return this.captures().clear().catch(this.logError);
  }

  async deleteAllSocialEdges() {
    return this.socialEdges().clear().catch(this.logError);
  }

  async deleteAllSearchDocuments() {
    return this.searchDocuments().clear().catch(this.logError);
  }

  async bundleDelete(bundleId: string) {
    await this.db
      .transaction(
        'rw',
        [
          this.importedBundles(),
          this.importedBundleCollections(),
          this.importedBundleItems(),
          this.importedEntitySnapshots(),
          this.importedBundleImportReports(),
          this.searchDocuments(),
        ],
        async () => {
          const collections = await this.importedBundleCollections()
            .where('bundle_id')
            .equals(bundleId)
            .primaryKeys();
          const items = await this.importedBundleItems()
            .where('bundle_id')
            .equals(bundleId)
            .primaryKeys();
          const snapshots = await this.importedEntitySnapshots()
            .where('bundle_id')
            .equals(bundleId)
            .primaryKeys();
          const reports = await this.importedBundleImportReports()
            .where('bundle_id')
            .equals(bundleId)
            .primaryKeys();
          const searchDocs = await this.searchDocuments()
            .where('bundle_id')
            .equals(bundleId)
            .primaryKeys();

          await this.importedBundleCollections().bulkDelete(collections);
          await this.importedBundleItems().bulkDelete(items);
          await this.importedEntitySnapshots().bulkDelete(snapshots);
          await this.importedBundleImportReports().bulkDelete(reports);
          await this.searchDocuments().bulkDelete(searchDocs);
          await this.importedBundles().delete(bundleId);
        },
      )
      .catch(this.logError);

    emitDatabaseMutation({ operation: 'bundleDelete', keys: [bundleId] });
  }

  private async enrichUsersWithRelationshipContext(
    extName: string,
    users: User[],
  ): Promise<User[]> {
    if (!users.length || (extName !== 'FollowersModule' && extName !== 'FollowingModule')) {
      return users;
    }

    const ids = this.normalizeDataKeys(users.map((user) => user.rest_id));
    if (!ids.length) {
      return users;
    }

    const edgeRows = await this.socialEdges()
      .where('[extension+related_user_id]')
      .anyOf(ids.map((id) => [extName, id] as [string, string]))
      .toArray()
      .catch(this.logError);

    if (!edgeRows?.length) {
      return users;
    }

    return enrichUsersWithRelationshipFields(users, edgeRows);
  }

  private normalizeDataKeys(values: string[]): string[] {
    const normalized = new Set<string>();
    for (const value of values) {
      const key = String(value || '').trim();
      if (!key) continue;
      normalized.add(key);
    }
    return [...normalized];
  }

  private filterEmptyData(data: Tweet | User) {
    if (!data) {
      logger.warn('Empty data found in DB', data);
      return false;
    }

    if ((data as Tweet).__typename === 'Tweet') {
      const tweet = data as Tweet;
      if (!tweet.legacy && !tweet.article) {
        logger.warn('Empty data found in DB', data);
        return false;
      }
      return true;
    }

    if (!data.legacy) {
      logger.warn('Empty data found in DB', data);
      return false;
    }
    return true;
  }

  /*
  |--------------------------------------------------------------------------
  | Migrations
  |--------------------------------------------------------------------------
  */

  async init() {
    // Indexes for the "tweets" table.
    const tweetIndexPaths: KeyPaths<Tweet>[] = [
      'rest_id',
      'twe_private_fields.created_at',
      'twe_private_fields.updated_at',
      'twe_private_fields.media_count',
      'core.user_results.result.core.screen_name',
      'legacy.favorite_count',
      'legacy.retweet_count',
      'legacy.bookmark_count',
      'legacy.quote_count',
      'legacy.reply_count',
      'views.count',
      'legacy.favorited',
      'legacy.retweeted',
      'legacy.bookmarked',
    ];

    // Indexes for the "users" table.
    const userIndexPaths: KeyPaths<User>[] = [
      'rest_id',
      'twe_private_fields.created_at',
      'twe_private_fields.updated_at',
      'core.screen_name',
      'legacy.followers_count',
      'legacy.friends_count',
      'legacy.statuses_count',
      'legacy.favourites_count',
      'legacy.listed_count',
      'verification.verified_type',
      'is_blue_verified',
      'relationship_perspectives.following',
      'relationship_perspectives.followed_by',
    ];

    // Indexes for the "captures" table.
    const captureIndexPaths = [
      'id',
      'extension',
      'type',
      'created_at',
      '[extension+type]',
      '[extension+type+created_at]',
    ] as Array<KeyPaths<Capture> | string>;

    // Indexes for the "social_edges" table.
    const socialEdgeIndexPaths = [
      'id',
      'extension',
      'relation_type',
      'subject_user_id',
      'related_user_id',
      'observed_at',
      '[extension+relation_type]',
      '[extension+subject_user_id]',
      '[extension+related_user_id]',
    ] as Array<KeyPaths<SocialEdge> | string>;

    const importedBundleIndexPaths = [
      'id',
      'status',
      'visibility',
      'importedAt',
      'updatedAt',
      'recordCount',
    ] as Array<KeyPaths<ImportedBundle> | string>;

    const importedBundleCollectionIndexPaths = [
      'id',
      'bundle_id',
      'kind',
      '[bundle_id+kind]',
    ] as Array<KeyPaths<ImportedBundleCollection> | string>;

    const importedBundleItemIndexPaths = [
      'id',
      'bundle_id',
      'collection_id',
      'record_id',
      'kind',
      'source_id',
      'sort_time',
      '[bundle_id+kind]',
      '[bundle_id+sort_time]',
    ] as Array<KeyPaths<ImportedBundleItem> | string>;

    const importedEntitySnapshotIndexPaths = [
      'id',
      'bundle_id',
      'kind',
      'source_id',
      'source_extension',
      'observed_at',
      'updated_at',
      '[bundle_id+kind]',
      '[kind+source_id]',
    ] as Array<KeyPaths<ImportedEntitySnapshot> | string>;

    const importedBundleImportReportIndexPaths = [
      'id',
      'bundle_id',
      'started_at',
      'finished_at',
      'status',
    ] as Array<KeyPaths<ImportedBundleImportReport> | string>;

    const searchDocumentIndexPaths = [
      'id',
      'source_key',
      'source_kind',
      'entity_type',
      'entity_id',
      'extension_name',
      'bundle_id',
      'bundle_item_id',
      'updated_at_ms',
      'created_at_ms',
      'observed_at_ms',
      'author_screen_name',
      'author_id',
      'folder_id',
      '[source_key+entity_type]',
      '[extension_name+entity_type]',
      '[bundle_id+entity_type]',
      '[entity_type+entity_id]',
    ] as Array<KeyPaths<SearchDocumentRow> | string>;

    // Take care of database schemas and versioning.
    // See: https://dexie.org/docs/Tutorial/Design#database-versioning
    try {
      this.db
        .version(2)
        .stores({
          tweets: tweetIndexPaths.join(','),
          users: userIndexPaths.join(','),
          captures: captureIndexPaths.join(','),
        })
        .upgrade(async (tx) => {
          logger.info('Upgrading database schema...');
          await migration_20250609(tx);
          logger.info('Database upgraded');
        });

      this.db.version(DB_VERSION).stores({
        tweets: tweetIndexPaths.join(','),
        users: userIndexPaths.join(','),
        captures: captureIndexPaths.join(','),
        social_edges: socialEdgeIndexPaths.join(','),
        imported_bundles: importedBundleIndexPaths.join(','),
        imported_bundle_collections: importedBundleCollectionIndexPaths.join(','),
        imported_bundle_items: importedBundleItemIndexPaths.join(','),
        imported_entity_snapshots: importedEntitySnapshotIndexPaths.join(','),
        imported_bundle_import_reports: importedBundleImportReportIndexPaths.join(','),
        search_documents: searchDocumentIndexPaths.join(','),
      });

      await this.db.open();
      logger.info(`Database connected: ${this.db.name}`);
    } catch (error) {
      this.logError(error);
    }
  }

  /*
  |--------------------------------------------------------------------------
  | Loggers
  |--------------------------------------------------------------------------
  */

  logError(error: unknown, operation?: string) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = operation ? `Database Error (${operation})` : 'Database Error';
    logger.error(`${prefix}: ${message}`, error);
  }
}
