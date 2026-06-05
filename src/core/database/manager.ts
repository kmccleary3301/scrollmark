import Dexie, { IndexableType, KeyPaths, Table } from 'dexie';
import { exportDB, importInto, type ImportOptions } from 'dexie-export-import';

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
import { getUnsafeWindow } from '@/utils/unsafe-window';
import { ExtensionType } from '../extensions/extension';
import { options } from '../options';
import { emitDatabaseMutation } from './mutation';
import type {
  CaptureResultCursor,
  ResultEntityType,
  SearchDocumentResultCursor,
} from './result-source';

// Keep the original database name permanently. Scrollmark is a rebrand, not a data reset:
// deriving this from package.json.name would strand existing captures in the legacy DB.
const DB_NAME = 'twitter-web-exporter';
const DB_VERSION = 10;
const CAPTURE_COUNT_SNAPSHOT_KEY = '__twe_capture_counts_v1';
const CAPTURE_COUNT_SNAPSHOT_V2_KEY = '__twe_capture_counts_v2';
const ACTIVE_DB_NAME_KEY = '__twe_active_db_name_v1';
const CAPTURE_INDEX_REVISION_KEY = '__twe_capture_index_revisions_v1';
const FOLDER_SOURCE_INDEX_REVISION_KEY = '__twe_folder_source_index_revisions_v1';
const CAPTURE_COUNT_EVENT_NAME = 'twe:capture-count-updated-v1';
const DB_WRITE_CHUNK_SIZE = 500;
const CAPTURE_INDEX_PAGE_SIZE = 256;
const FOLDER_SOURCE_INDEX_PAGE_SIZE = 256;
const CAPTURE_INDEX_BACKGROUND_BUILD_MIN_COUNT = 1000;
const CAPTURE_INDEX_BACKGROUND_BUILD_DELAY_MS = 1500;
const MIN_TIME_INDEX_KEY = 0;
const MAX_TIME_INDEX_KEY = Number.MAX_SAFE_INTEGER;
const MIN_STRING_INDEX_KEY = '';
const MAX_STRING_INDEX_KEY = '\uffff';

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
  media_flag?: number;
  route_type?: string;
  lang?: string;
  flags_json?: Record<string, boolean>;
  exact_json?: Record<string, string | string[]>;
  numeric_json?: Record<string, number>;
  raw_ref_table: 'tweets' | 'users' | 'imported_entity_snapshots';
  raw_ref_key: string;
  doc_hash: string;
}

export interface CaptureCursorPage {
  captures: Capture[];
  cursorBefore?: CaptureResultCursor;
  cursorAfter?: CaptureResultCursor;
  hasBefore: boolean;
  hasAfter: boolean;
}

export interface SearchDocumentCursorPage {
  documents: SearchDocumentRow[];
  cursorBefore?: SearchDocumentResultCursor;
  cursorAfter?: SearchDocumentResultCursor;
  hasBefore: boolean;
  hasAfter: boolean;
}

export type BookmarkFolderStatus = 'api-name' | 'id-only' | 'none';

export interface SearchDocumentFolderFacet {
  folderId: string;
  label: string;
  count: number;
  status: BookmarkFolderStatus;
}

export interface SearchDocumentFolderFacetSummary {
  totalDocuments: number;
  statusCounts: Record<BookmarkFolderStatus, number>;
  facets: SearchDocumentFolderFacet[];
}

interface SyntheticSeedBulkRows {
  users?: User[];
  tweets?: Tweet[];
  captures?: Capture[];
  searchDocuments?: SearchDocumentRow[];
}

export interface CaptureIndexPageRow {
  id: string;
  extension: string;
  type: string;
  order: 'newest' | 'oldest';
  source_count: number;
  source_revision: number;
  page_start: number;
  page_size: number;
  data_keys: string[];
  built_at_ms: number;
}

export interface FolderSourceIndexPageRow {
  id: string;
  source_hash: string;
  source_key: string;
  extension_name: string;
  entity_type: ResultEntityType;
  folder_ids_key: string;
  source_count: number;
  source_revision: number;
  page_start: number;
  page_size: number;
  row_ids: string[];
  cursor_after?: SearchDocumentResultCursor;
  built_at_ms: number;
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

function entityTypeFromExtensionType(type?: ExtensionType): ResultEntityType | '' {
  if (type === ExtensionType.USER) return 'user';
  if (type === ExtensionType.TWEET) return 'tweet';
  return '';
}

function captureCursorFromRow(row: Capture | undefined): CaptureResultCursor | undefined {
  if (!row) return undefined;
  return {
    createdAt: Number(row.created_at) || 0,
    captureId: row.id,
  };
}

function searchDocumentCursorFromRow(
  row: SearchDocumentRow | undefined,
): SearchDocumentResultCursor | undefined {
  if (!row) return undefined;
  return {
    observedAtMs: Number(row.observed_at_ms || row.created_at_ms || row.updated_at_ms) || 0,
    documentId: row.id,
  };
}

function getBookmarkFolderStatus(row: SearchDocumentRow): BookmarkFolderStatus {
  if (row.folder_id && row.folder_name) return 'api-name';
  if (row.folder_id) return 'id-only';
  return 'none';
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
  private ready: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  private captureIndexBuilds = new Map<string, Promise<boolean>>();
  private captureIndexRevisionFallback = new Map<string, number>();

  constructor() {
    let userId = 'unknown';
    try {
      const globalObject = getUnsafeWindow() as typeof globalThis & {
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
    this.ready = this.init();
  }

  async whenReady(): Promise<void> {
    await this.ready;
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

  private captureIndexPages() {
    return this.db.table<CaptureIndexPageRow>('capture_index_pages');
  }

  private folderSourceIndexPages() {
    return this.db.table<FolderSourceIndexPageRow>('folder_source_index_pages');
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

  private normalizeFolderSourceIds(folderIds: string[]): string[] {
    return [
      ...new Set(folderIds.map((folderId) => String(folderId || '').trim()).filter(Boolean)),
    ].sort();
  }

  private folderSourceIndexRevisionId(extName: string): string {
    return [this.db.name, extName].join('|');
  }

  private folderSourceHash(sourceKey: string): string {
    return simpleHash(sourceKey);
  }

  private folderSourceIndexPageId(args: {
    sourceKey: string;
    sourceCount: number;
    sourceRevision: number;
    pageStart: number;
  }): string {
    return [
      this.folderSourceHash(args.sourceKey),
      Math.max(0, Math.floor(args.sourceCount)),
      Math.max(0, Math.floor(args.sourceRevision)),
      Math.max(0, Math.floor(args.pageStart)),
    ].join('|');
  }

  private readFolderSourceIndexRevisionMap(): Record<string, number> {
    const collect = (source: unknown): Record<string, number> | null => {
      if (!source || typeof source !== 'object') return null;
      const value = (source as Record<string, unknown>)[FOLDER_SOURCE_INDEX_REVISION_KEY];
      if (!value || typeof value !== 'object') return null;
      const out: Record<string, number> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const revision = Number(raw);
        if (Number.isFinite(revision) && revision >= 0) {
          out[key] = Math.floor(revision);
        }
      }
      return out;
    };

    let map: Record<string, number> = {};
    try {
      map = { ...map, ...(collect(globalThis) ?? {}) };
    } catch {
      // ignore
    }
    try {
      if (typeof window !== 'undefined') {
        map = { ...map, ...(collect(window) ?? {}) };
      }
    } catch {
      // ignore
    }
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(FOLDER_SOURCE_INDEX_REVISION_KEY);
        if (raw) {
          map = {
            ...map,
            ...(collect({ [FOLDER_SOURCE_INDEX_REVISION_KEY]: JSON.parse(raw) }) ?? {}),
          };
        }
      }
    } catch {
      // ignore
    }
    return map;
  }

  private writeFolderSourceIndexRevisionMap(map: Record<string, number>): void {
    try {
      const normalized: Record<string, number> = {};
      for (const [key, raw] of Object.entries(map)) {
        const revision = Number(raw);
        if (Number.isFinite(revision) && revision >= 0) {
          normalized[key] = Math.floor(revision);
        }
      }
      (globalThis as Record<string, unknown>)[FOLDER_SOURCE_INDEX_REVISION_KEY] = normalized;
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>)[FOLDER_SOURCE_INDEX_REVISION_KEY] =
          normalized;
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(FOLDER_SOURCE_INDEX_REVISION_KEY, JSON.stringify(normalized));
      }
    } catch {
      // ignore revision persistence failures
    }
  }

  private bumpFolderSourceIndexRevision(extName: string): number {
    const key = this.folderSourceIndexRevisionId(extName);
    const map = this.readFolderSourceIndexRevisionMap();
    const next = Math.max(0, Math.floor(Number(map[key]) || 0)) + 1;
    map[key] = next;
    this.writeFolderSourceIndexRevisionMap(map);
    return next;
  }

  readFolderSourceIndexRevision(extName: string): number {
    const key = this.folderSourceIndexRevisionId(extName);
    const map = this.readFolderSourceIndexRevisionMap();
    return Math.max(0, Math.floor(Number(map[key]) || 0));
  }

  private async deleteFolderSourceIndexPages(extName?: string): Promise<void> {
    if (!extName) {
      await this.folderSourceIndexPages()
        .clear()
        .catch((error) => this.logError(error, 'deleteFolderSourceIndexPages:clear'));
      return;
    }
    await this.folderSourceIndexPages()
      .where('extension_name')
      .equals(extName)
      .delete()
      .catch((error) => this.logError(error, 'deleteFolderSourceIndexPages:extension'));
  }

  private async invalidateFolderSourceIndexPages(extName?: string): Promise<void> {
    if (extName) {
      this.bumpFolderSourceIndexRevision(extName);
      await this.deleteFolderSourceIndexPages(extName);
      return;
    }
    const map = this.readFolderSourceIndexRevisionMap();
    const prefix = `${this.db.name}|`;
    for (const key of Object.keys(map).filter((candidate) => candidate.startsWith(prefix))) {
      map[key] = Math.max(0, Math.floor(Number(map[key]) || 0)) + 1;
    }
    this.writeFolderSourceIndexRevisionMap(map);
    await this.deleteFolderSourceIndexPages();
  }

  private searchDocumentExtensionNames(rows: SearchDocumentRow[]): string[] {
    return [...new Set(rows.map((row) => String(row.extension_name || '').trim()).filter(Boolean))];
  }

  private async invalidateFolderSourceIndexPagesForExtensions(extNames: string[]): Promise<void> {
    const uniqueExtNames = [...new Set(extNames.map((extName) => extName.trim()).filter(Boolean))];
    if (!uniqueExtNames.length) return;
    for (const extName of uniqueExtNames) {
      await this.invalidateFolderSourceIndexPages(extName);
    }
  }

  async extPutFolderSourceIndexPages(args: {
    sourceKey: string;
    extensionName: string;
    entityType: ResultEntityType;
    folderIds: string[];
    sourceCount: number;
    sourceRevision: number;
    pages: Array<{
      pageStart: number;
      rowIds: string[];
      cursorAfter?: SearchDocumentResultCursor;
    }>;
  }): Promise<void> {
    const folderIds = this.normalizeFolderSourceIds(args.folderIds);
    const folderIdsKey = folderIds.join('\n');
    const sourceCount = Math.max(0, Math.floor(Number(args.sourceCount) || 0));
    const sourceRevision = Math.max(0, Math.floor(Number(args.sourceRevision) || 0));
    const builtAt = Date.now();
    const rows: FolderSourceIndexPageRow[] = args.pages.map((page) => {
      const pageStart = Math.max(0, Math.floor(Number(page.pageStart) || 0));
      return {
        id: this.folderSourceIndexPageId({
          sourceKey: args.sourceKey,
          sourceCount,
          sourceRevision,
          pageStart,
        }),
        source_hash: this.folderSourceHash(args.sourceKey),
        source_key: args.sourceKey,
        extension_name: args.extensionName,
        entity_type: args.entityType,
        folder_ids_key: folderIdsKey,
        source_count: sourceCount,
        source_revision: sourceRevision,
        page_start: pageStart,
        page_size: FOLDER_SOURCE_INDEX_PAGE_SIZE,
        row_ids: this.normalizeDataKeys(page.rowIds),
        cursor_after: page.cursorAfter,
        built_at_ms: builtAt,
      };
    });

    await this.enqueueWrite('extPutFolderSourceIndexPages', async () => {
      await this.db.transaction('rw', this.folderSourceIndexPages(), async () => {
        await this.folderSourceIndexPages()
          .where('source_hash')
          .equals(this.folderSourceHash(args.sourceKey))
          .filter((row) => row.source_key === args.sourceKey)
          .delete();
        if (rows.length) {
          await this.bulkPutInChunks(this.folderSourceIndexPages(), rows);
        }
      });
    });
    recordPerfMetric({
      kind: 'db',
      name: 'folder-source-index-pages-put',
      value: rows.length,
      tags: {
        extName: args.extensionName,
        entityType: args.entityType,
        folderCount: folderIds.length,
        sourceCount,
        sourceRevision,
      },
    });
  }

  async extGetFolderSourceIndexedPage(args: {
    sourceKey: string;
    extensionName: string;
    entityType: ResultEntityType;
    folderIds: string[];
    sourceCount: number;
    offset?: number;
    limit?: number;
  }): Promise<{ rowIds: string[]; cursorAfter?: SearchDocumentResultCursor } | null> {
    const startedAt = nowMs();
    const sourceCount = Math.max(0, Math.floor(Number(args.sourceCount) || 0));
    if (!sourceCount) return null;
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
    const sourceRevision = this.readFolderSourceIndexRevision(args.extensionName);
    const firstPageStart =
      Math.floor(offset / FOLDER_SOURCE_INDEX_PAGE_SIZE) * FOLDER_SOURCE_INDEX_PAGE_SIZE;
    const lastIndex = Math.max(offset, offset + limit - 1);
    const lastPageStart =
      Math.floor(lastIndex / FOLDER_SOURCE_INDEX_PAGE_SIZE) * FOLDER_SOURCE_INDEX_PAGE_SIZE;
    const pageStarts: number[] = [];
    for (
      let pageStart = firstPageStart;
      pageStart <= lastPageStart;
      pageStart += FOLDER_SOURCE_INDEX_PAGE_SIZE
    ) {
      pageStarts.push(pageStart);
    }
    const pageIds = pageStarts.map((pageStart) =>
      this.folderSourceIndexPageId({
        sourceKey: args.sourceKey,
        sourceCount,
        sourceRevision,
        pageStart,
      }),
    );
    const pages = await this.folderSourceIndexPages().bulkGet(pageIds).catch(this.logError);
    if (!pages || pages.some((page) => !page)) {
      recordPerfMetric({
        kind: 'db',
        name: 'folder-source-index-page-miss',
        durationMs: nowMs() - startedAt,
        value: 0,
        tags: {
          extName: args.extensionName,
          entityType: args.entityType,
          offset,
          limit,
          sourceCount,
          sourceRevision,
        },
      });
      return null;
    }

    const folderIdsKey = this.normalizeFolderSourceIds(args.folderIds).join('\n');
    const typedPages = pages as FolderSourceIndexPageRow[];
    if (
      typedPages.some(
        (page) =>
          page.source_key !== args.sourceKey ||
          page.extension_name !== args.extensionName ||
          page.entity_type !== args.entityType ||
          page.folder_ids_key !== folderIdsKey ||
          page.source_count !== sourceCount ||
          page.source_revision !== sourceRevision ||
          page.page_size !== FOLDER_SOURCE_INDEX_PAGE_SIZE,
      )
    ) {
      recordPerfMetric({
        kind: 'db',
        name: 'folder-source-index-page-stale',
        durationMs: nowMs() - startedAt,
        value: 0,
        tags: {
          extName: args.extensionName,
          entityType: args.entityType,
          offset,
          limit,
          sourceCount,
          sourceRevision,
        },
      });
      return null;
    }

    const orderedPages = typedPages.sort((left, right) => left.page_start - right.page_start);
    const rowIds = orderedPages.flatMap((page) => page.row_ids);
    const sliceStart = offset - firstPageStart;
    const result = rowIds.slice(sliceStart, sliceStart + limit);
    recordPerfMetric({
      kind: 'db',
      name: 'folder-source-index-page',
      durationMs: nowMs() - startedAt,
      value: result.length,
      tags: {
        extName: args.extensionName,
        entityType: args.entityType,
        folderCount: args.folderIds.length,
        offset,
        limit,
        sourceCount,
        sourceRevision,
        pages: pageIds.length,
      },
    });
    return {
      rowIds: result,
      cursorAfter:
        sliceStart + result.length === rowIds.length
          ? orderedPages[orderedPages.length - 1]?.cursor_after
          : undefined,
    };
  }

  async extGetCaptures(extName: string) {
    return this.captures().where('extension').equals(extName).toArray().catch(this.logError);
  }

  async extGetCaptureCount(extName: string, type?: ExtensionType) {
    const startedAt = nowMs();
    const count =
      (await (type
        ? this.captures()
            .where('[extension+type]')
            .equals([extName, type])
            .count()
            .catch(this.logError)
        : this.captures().where('extension').equals(extName).count().catch(this.logError))) ?? 0;
    recordPerfMetric({
      kind: 'db',
      name: 'capture-count',
      durationMs: nowMs() - startedAt,
      value: count,
      tags: { extName, type },
    });
    return count;
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

  private captureIndexPageId(args: {
    extName: string;
    type: string;
    order: 'newest' | 'oldest';
    sourceCount: number;
    pageStart: number;
  }): string {
    return [
      args.extName,
      args.type,
      args.order,
      Math.max(0, Math.floor(args.sourceCount)),
      Math.max(0, Math.floor(args.pageStart)),
    ].join('|');
  }

  private captureIndexRevisionId(extName: string, type: string): string {
    return [this.db.name, extName, type].join('|');
  }

  private readCaptureIndexRevisionMap(): Record<string, number> {
    const collect = (source: unknown): Record<string, number> | null => {
      if (!source || typeof source !== 'object') return null;
      const value = (source as Record<string, unknown>)[CAPTURE_INDEX_REVISION_KEY];
      if (!value || typeof value !== 'object') return null;
      const out: Record<string, number> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const revision = Number(raw);
        if (Number.isFinite(revision) && revision >= 0) {
          out[key] = Math.floor(revision);
        }
      }
      return out;
    };

    let map: Record<string, number> = {};
    try {
      map = { ...map, ...(collect(globalThis) ?? {}) };
    } catch {
      // ignore
    }
    try {
      if (typeof window !== 'undefined') {
        map = { ...map, ...(collect(window) ?? {}) };
      }
    } catch {
      // ignore
    }
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(CAPTURE_INDEX_REVISION_KEY);
        if (raw) {
          map = { ...map, ...(collect({ [CAPTURE_INDEX_REVISION_KEY]: JSON.parse(raw) }) ?? {}) };
        }
      }
    } catch {
      // ignore
    }
    for (const [key, revision] of this.captureIndexRevisionFallback) {
      map[key] = Math.max(Number(map[key]) || 0, revision);
    }
    return map;
  }

  private writeCaptureIndexRevisionMap(map: Record<string, number>): void {
    try {
      const normalized: Record<string, number> = {};
      for (const [key, raw] of Object.entries(map)) {
        const revision = Number(raw);
        if (Number.isFinite(revision) && revision >= 0) {
          normalized[key] = Math.floor(revision);
          this.captureIndexRevisionFallback.set(key, Math.floor(revision));
        }
      }
      (globalThis as Record<string, unknown>)[CAPTURE_INDEX_REVISION_KEY] = normalized;
      if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>)[CAPTURE_INDEX_REVISION_KEY] = normalized;
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(CAPTURE_INDEX_REVISION_KEY, JSON.stringify(normalized));
      }
    } catch {
      // ignore revision persistence failures
    }
  }

  private readCaptureIndexRevision(extName: string, type: string): number {
    const key = this.captureIndexRevisionId(extName, type);
    const map = this.readCaptureIndexRevisionMap();
    const revision = Math.max(0, Math.floor(Number(map[key]) || 0));
    if (!this.captureIndexRevisionFallback.has(key)) {
      this.captureIndexRevisionFallback.set(key, revision);
    }
    return revision;
  }

  private bumpCaptureIndexRevision(extName: string, type: string): number {
    const key = this.captureIndexRevisionId(extName, type);
    const map = this.readCaptureIndexRevisionMap();
    const next = Math.max(0, Math.floor(Number(map[key]) || 0)) + 1;
    map[key] = next;
    this.writeCaptureIndexRevisionMap(map);
    return next;
  }

  private bumpAllCaptureIndexRevisions(): void {
    const map = this.readCaptureIndexRevisionMap();
    const prefix = `${this.db.name}|`;
    for (const key of new Set([
      ...Object.keys(map).filter((candidate) => candidate.startsWith(prefix)),
      ...[...this.captureIndexRevisionFallback.keys()].filter((candidate) =>
        candidate.startsWith(prefix),
      ),
    ])) {
      map[key] = Math.max(0, Math.floor(Number(map[key]) || 0)) + 1;
    }
    this.writeCaptureIndexRevisionMap(map);
  }

  private async deleteCaptureIndexPagesForScope(
    extName: string,
    type?: string,
    order?: 'newest' | 'oldest',
  ): Promise<void> {
    await this.captureIndexPages()
      .where('extension')
      .equals(extName)
      .filter((row) => {
        if (type && row.type !== type) return false;
        if (order && row.order !== order) return false;
        return true;
      })
      .delete()
      .catch((error) => this.logError(error, 'deleteCaptureIndexPagesForScope'));
  }

  private async invalidateCaptureIndexPages(
    extName: string,
    type?: string,
    args: { deletePages?: boolean } = {},
  ): Promise<void> {
    if (!extName) return;
    const deletePages = args.deletePages ?? true;
    if (type) {
      this.bumpCaptureIndexRevision(extName, type);
      if (deletePages) {
        await this.deleteCaptureIndexPagesForScope(extName, type);
      }
      return;
    }

    const rows =
      (await this.captureIndexPages()
        .where('extension')
        .equals(extName)
        .toArray()
        .catch(this.logError)) ?? [];
    const types = new Set(rows.map((row) => String(row.type || '')).filter(Boolean));
    if (!types.size) {
      const revisionPrefix = `${this.db.name}|${extName}|`;
      for (const key of Object.keys(this.readCaptureIndexRevisionMap())) {
        if (key.startsWith(revisionPrefix)) {
          const rowType = key.slice(revisionPrefix.length);
          if (rowType) types.add(rowType);
        }
      }
    }
    for (const rowType of types) {
      this.bumpCaptureIndexRevision(extName, rowType);
    }
    if (deletePages) {
      await this.deleteCaptureIndexPagesForScope(extName);
    }
  }

  private async invalidateCaptureIndexPagesForRows(captures: Capture[]): Promise<void> {
    const scopes = new Map<string, Set<string>>();
    for (const capture of captures) {
      const extName = String(capture?.extension || '').trim();
      const type = String(capture?.type || '').trim();
      if (!extName || !type) continue;
      const set = scopes.get(extName) ?? new Set<string>();
      set.add(type);
      scopes.set(extName, set);
    }
    for (const [extName, types] of scopes) {
      for (const type of types) {
        await this.invalidateCaptureIndexPages(extName, type);
      }
    }
  }

  async extPutCaptureIndexPagesFromOrderedCaptures(
    extName: string,
    type: ExtensionType,
    captures: Capture[],
    sourceCount: number,
    order: 'newest' | 'oldest' = 'newest',
  ): Promise<void> {
    if (!captures.length) return;
    const normalizedSourceCount = Math.max(0, Math.floor(Number(sourceCount) || 0));
    const startedAt = nowMs();
    const builtAt = Date.now();
    const sourceRevision = this.readCaptureIndexRevision(extName, type);
    const pages: CaptureIndexPageRow[] = [];

    for (let pageStart = 0; pageStart < captures.length; pageStart += CAPTURE_INDEX_PAGE_SIZE) {
      const pageCaptures = captures.slice(pageStart, pageStart + CAPTURE_INDEX_PAGE_SIZE);
      pages.push({
        id: this.captureIndexPageId({
          extName,
          type,
          order,
          sourceCount: normalizedSourceCount,
          pageStart,
        }),
        extension: extName,
        type,
        order,
        source_count: normalizedSourceCount,
        source_revision: sourceRevision,
        page_start: pageStart,
        page_size: CAPTURE_INDEX_PAGE_SIZE,
        data_keys: this.normalizeDataKeys(pageCaptures.map((capture) => capture.data_key)),
        built_at_ms: builtAt,
      });
    }

    await this.enqueueWrite('extPutCaptureIndexPagesFromOrderedCaptures', async () => {
      await this.db.transaction('rw', this.captureIndexPages(), async () => {
        await this.deleteCaptureIndexPagesForScope(extName, type, order);
        await this.bulkPutInChunks(this.captureIndexPages(), pages);
      });
    });
    recordPerfMetric({
      kind: 'db',
      name: 'capture-index-pages-put',
      durationMs: nowMs() - startedAt,
      value: pages.length,
      tags: { extName, type, order, sourceCount: normalizedSourceCount, sourceRevision },
    });
  }

  private scheduleCaptureIndexPageBuild(
    extName: string,
    args: {
      type: ExtensionType;
      order?: 'newest' | 'oldest';
      sourceCount?: number;
    },
  ): void {
    const sourceCount = Math.max(0, Math.floor(Number(args.sourceCount) || 0));
    if (sourceCount < CAPTURE_INDEX_BACKGROUND_BUILD_MIN_COUNT) return;
    const order = args.order ?? 'newest';
    const key = [this.db.name, extName, args.type, order, sourceCount].join('|');
    if (this.captureIndexBuilds.has(key)) return;
    const build = new Promise<boolean>((resolve, reject) => {
      globalThis.setTimeout(() => {
        this.extBuildCaptureIndexPages(extName, {
          type: args.type,
          order,
          sourceCount,
        }).then(resolve, reject);
      }, CAPTURE_INDEX_BACKGROUND_BUILD_DELAY_MS);
    }).finally(() => {
      this.captureIndexBuilds.delete(key);
    });
    this.captureIndexBuilds.set(key, build);
    void build.catch((error) => {
      this.logError(error, 'scheduleCaptureIndexPageBuild');
    });
  }

  async extBuildCaptureIndexPages(
    extName: string,
    args: {
      type: ExtensionType;
      order?: 'newest' | 'oldest';
      sourceCount?: number;
    },
  ): Promise<boolean> {
    const startedAt = nowMs();
    const order = args.order ?? 'newest';
    const expectedCount =
      typeof args.sourceCount === 'number' && Number.isFinite(args.sourceCount)
        ? Math.max(0, Math.floor(args.sourceCount))
        : Math.max(0, Math.floor(Number(await this.extGetCaptureCount(extName, args.type)) || 0));
    if (!expectedCount) return false;

    const sourceRevision = this.readCaptureIndexRevision(extName, args.type);
    const builtAt = Date.now();
    const pages: CaptureIndexPageRow[] = [];
    let pageStart = 0;
    let cursor: CaptureResultCursor | undefined;
    let pendingIds: string[] = [];

    while (true) {
      const page = await this.extGetCaptureCursorPage(extName, {
        type: args.type,
        after: cursor,
        limit: 1000,
        order,
      });
      pendingIds.push(...this.normalizeDataKeys(page.captures.map((capture) => capture.data_key)));
      while (pendingIds.length >= CAPTURE_INDEX_PAGE_SIZE) {
        const dataKeys = pendingIds.slice(0, CAPTURE_INDEX_PAGE_SIZE);
        pendingIds = pendingIds.slice(CAPTURE_INDEX_PAGE_SIZE);
        pages.push({
          id: this.captureIndexPageId({
            extName,
            type: args.type,
            order,
            sourceCount: expectedCount,
            pageStart,
          }),
          extension: extName,
          type: args.type,
          order,
          source_count: expectedCount,
          source_revision: sourceRevision,
          page_start: pageStart,
          page_size: CAPTURE_INDEX_PAGE_SIZE,
          data_keys: dataKeys,
          built_at_ms: builtAt,
        });
        pageStart += CAPTURE_INDEX_PAGE_SIZE;
      }

      if (!page.hasAfter || !page.cursorAfter || !page.captures.length) break;
      cursor = page.cursorAfter;
    }

    if (pendingIds.length) {
      pages.push({
        id: this.captureIndexPageId({
          extName,
          type: args.type,
          order,
          sourceCount: expectedCount,
          pageStart,
        }),
        extension: extName,
        type: args.type,
        order,
        source_count: expectedCount,
        source_revision: sourceRevision,
        page_start: pageStart,
        page_size: CAPTURE_INDEX_PAGE_SIZE,
        data_keys: pendingIds,
        built_at_ms: builtAt,
      });
    }

    const currentCount = Math.max(
      0,
      Math.floor(Number(await this.extGetCaptureCount(extName, args.type)) || 0),
    );
    const currentRevision = this.readCaptureIndexRevision(extName, args.type);
    if (currentCount !== expectedCount || currentRevision !== sourceRevision) {
      recordPerfMetric({
        kind: 'db',
        name: 'capture-index-build-stale',
        durationMs: nowMs() - startedAt,
        value: pages.length,
        tags: {
          extName,
          type: args.type,
          order,
          expectedCount,
          currentCount,
          sourceRevision,
          currentRevision,
        },
      });
      return false;
    }

    await this.enqueueWrite('extBuildCaptureIndexPages', async () => {
      if (this.readCaptureIndexRevision(extName, args.type) !== sourceRevision) {
        return;
      }
      await this.db.transaction('rw', this.captureIndexPages(), async () => {
        await this.deleteCaptureIndexPagesForScope(extName, args.type, order);
        await this.bulkPutInChunks(this.captureIndexPages(), pages);
      });
    });
    recordPerfMetric({
      kind: 'db',
      name: 'capture-index-build',
      durationMs: nowMs() - startedAt,
      value: pages.length,
      tags: { extName, type: args.type, order, sourceCount: expectedCount, sourceRevision },
    });
    return true;
  }

  async extGetCaptureIdsIndexedPage(
    extName: string,
    args: {
      type: ExtensionType;
      offset?: number;
      limit?: number;
      order?: 'newest' | 'oldest';
      sourceCount?: number;
    },
  ): Promise<string[] | null> {
    const startedAt = nowMs();
    const sourceCount = Math.max(0, Math.floor(Number(args.sourceCount) || 0));
    if (!sourceCount) return null;

    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
    const order = args.order ?? 'newest';
    const firstPageStart = Math.floor(offset / CAPTURE_INDEX_PAGE_SIZE) * CAPTURE_INDEX_PAGE_SIZE;
    const lastIndex = Math.max(offset, offset + limit - 1);
    const lastPageStart = Math.floor(lastIndex / CAPTURE_INDEX_PAGE_SIZE) * CAPTURE_INDEX_PAGE_SIZE;
    const pageStarts: number[] = [];
    for (
      let pageStart = firstPageStart;
      pageStart <= lastPageStart;
      pageStart += CAPTURE_INDEX_PAGE_SIZE
    ) {
      pageStarts.push(pageStart);
    }

    const pageIds = pageStarts.map((pageStart) =>
      this.captureIndexPageId({ extName, type: args.type, order, sourceCount, pageStart }),
    );
    const pages = await this.captureIndexPages().bulkGet(pageIds).catch(this.logError);
    if (!pages || pages.some((page) => !page)) {
      this.scheduleCaptureIndexPageBuild(extName, {
        type: args.type,
        order,
        sourceCount,
      });
      recordPerfMetric({
        kind: 'db',
        name: 'capture-index-page-miss',
        durationMs: nowMs() - startedAt,
        value: 0,
        tags: { extName, type: args.type, offset, limit, order, sourceCount },
      });
      return null;
    }

    const sourceRevision = this.readCaptureIndexRevision(extName, args.type);
    const typedPages = pages as CaptureIndexPageRow[];
    if (
      typedPages.some(
        (page) =>
          page.source_revision !== sourceRevision ||
          page.source_count !== sourceCount ||
          page.page_size !== CAPTURE_INDEX_PAGE_SIZE,
      )
    ) {
      this.scheduleCaptureIndexPageBuild(extName, {
        type: args.type,
        order,
        sourceCount,
      });
      recordPerfMetric({
        kind: 'db',
        name: 'capture-index-page-stale',
        durationMs: nowMs() - startedAt,
        value: 0,
        tags: { extName, type: args.type, offset, limit, order, sourceCount, sourceRevision },
      });
      return null;
    }

    const dataKeys = typedPages
      .sort((left, right) => left.page_start - right.page_start)
      .flatMap((page) => page.data_keys);
    const sliceStart = offset - firstPageStart;
    const result = dataKeys.slice(sliceStart, sliceStart + limit);
    recordPerfMetric({
      kind: 'db',
      name: 'capture-index-page',
      durationMs: nowMs() - startedAt,
      value: result.length,
      tags: {
        extName,
        type: args.type,
        offset,
        limit,
        order,
        sourceCount,
        sourceRevision,
        pages: pageIds.length,
      },
    });
    return result;
  }

  async extGetCaptureCursorPage(
    extName: string,
    args: {
      type: ExtensionType;
      after?: CaptureResultCursor;
      before?: CaptureResultCursor;
      limit?: number;
      order?: 'newest' | 'oldest';
    },
  ): Promise<CaptureCursorPage> {
    const startedAt = nowMs();
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
    const order = args.order ?? 'newest';
    const minKey = [
      extName,
      args.type,
      MIN_TIME_INDEX_KEY,
      MIN_STRING_INDEX_KEY,
    ] as IndexableType[];
    const maxKey = [
      extName,
      args.type,
      MAX_TIME_INDEX_KEY,
      MAX_STRING_INDEX_KEY,
    ] as IndexableType[];
    let lower = minKey;
    let upper = maxKey;
    let includeLower = true;
    let includeUpper = true;
    const cursor = args.after ?? args.before;

    if (cursor) {
      const cursorKey = [extName, args.type, cursor.createdAt, cursor.captureId] as IndexableType[];
      if (args.before) {
        if (order === 'newest') {
          lower = cursorKey;
          includeLower = false;
        } else {
          upper = cursorKey;
          includeUpper = false;
        }
      } else if (order === 'newest') {
        upper = cursorKey;
        includeUpper = false;
      } else {
        lower = cursorKey;
        includeLower = false;
      }
    }

    let collection = this.captures()
      .where('[extension+type+created_at+id]')
      .between(lower, upper, includeLower, includeUpper);
    if (order === 'newest') {
      collection = collection.reverse();
    }
    const rows =
      (await collection
        .limit(limit + 1)
        .toArray()
        .catch(this.logError)) ?? [];
    const captures = rows.slice(0, limit);
    const hasExtra = rows.length > limit;
    const result: CaptureCursorPage = {
      captures,
      cursorBefore: captureCursorFromRow(captures[0]),
      cursorAfter: captureCursorFromRow(captures[captures.length - 1]),
      hasBefore: Boolean(args.after || args.before),
      hasAfter: hasExtra,
    };

    recordPerfMetric({
      kind: 'db',
      name: 'capture-cursor-page',
      durationMs: nowMs() - startedAt,
      value: captures.length,
      tags: {
        extName,
        type: args.type,
        limit,
        order,
        hasAfter: result.hasAfter,
        cursorCreatedAt: cursor?.createdAt,
      },
    });
    return result;
  }

  async extGetCaptureIdsCursorPage(
    extName: string,
    args: {
      type: ExtensionType;
      after?: CaptureResultCursor;
      before?: CaptureResultCursor;
      limit?: number;
      order?: 'newest' | 'oldest';
    },
  ) {
    const page = await this.extGetCaptureCursorPage(extName, args);
    return {
      ...page,
      ids: this.normalizeDataKeys(page.captures.map((capture) => capture.data_key)),
    };
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
    const entityType = entityTypeFromExtensionType(type);
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

  async extGetSearchDocumentPage(
    extName: string,
    args: {
      type?: ExtensionType;
      entityType?: ResultEntityType;
      offset?: number;
      limit?: number;
    } = {},
  ): Promise<SearchDocumentCursorPage> {
    const startedAt = nowMs();
    const entityType = args.entityType ?? entityTypeFromExtensionType(args.type);
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const limit = Math.max(1, Math.min(5000, Number(args.limit) || 1000));
    const collection = entityType
      ? this.searchDocuments().where('[extension_name+entity_type]').equals([extName, entityType])
      : this.searchDocuments().where('extension_name').equals(extName);
    const rows =
      (await collection
        .offset(offset)
        .limit(limit + 1)
        .toArray()
        .catch(this.logError)) ?? [];
    const documents = rows.slice(0, limit);
    const result: SearchDocumentCursorPage = {
      documents,
      cursorBefore: searchDocumentCursorFromRow(documents[0]),
      cursorAfter: searchDocumentCursorFromRow(documents[documents.length - 1]),
      hasBefore: offset > 0,
      hasAfter: rows.length > limit,
    };

    recordPerfMetric({
      kind: 'db',
      name: 'search-document-page',
      durationMs: nowMs() - startedAt,
      value: documents.length,
      tags: {
        extName,
        type: args.type,
        entityType,
        offset,
        limit,
        hasAfter: result.hasAfter,
      },
    });
    return result;
  }

  async extGetSearchDocumentCount(
    extName: string,
    args: {
      type?: ExtensionType;
      entityType?: ResultEntityType;
      folderId?: string;
      sourceKey?: string;
    } = {},
  ) {
    const startedAt = nowMs();
    const entityType = args.entityType ?? entityTypeFromExtensionType(args.type);
    const folderId = String(args.folderId || '').trim();
    const sourceKey = String(args.sourceKey || '').trim();

    let count = 0;
    if (entityType && folderId && !sourceKey) {
      count =
        (await this.searchDocuments()
          .where('[extension_name+entity_type+folder_id+observed_at_ms+id]')
          .between(
            [extName, entityType, folderId, MIN_TIME_INDEX_KEY, MIN_STRING_INDEX_KEY],
            [extName, entityType, folderId, MAX_TIME_INDEX_KEY, MAX_STRING_INDEX_KEY],
            true,
            true,
          )
          .count()
          .catch(this.logError)) ?? 0;
    } else if (sourceKey && entityType) {
      count =
        (await this.searchDocuments()
          .where('[source_key+entity_type]')
          .equals([sourceKey, entityType])
          .filter((row) => !folderId || row.folder_id === folderId)
          .count()
          .catch(this.logError)) ?? 0;
    } else if (entityType) {
      count =
        (await this.searchDocuments()
          .where('[extension_name+entity_type]')
          .equals([extName, entityType])
          .filter((row) => !folderId || row.folder_id === folderId)
          .count()
          .catch(this.logError)) ?? 0;
    } else {
      count =
        (await this.searchDocuments()
          .where('extension_name')
          .equals(extName)
          .filter((row) => !folderId || row.folder_id === folderId)
          .count()
          .catch(this.logError)) ?? 0;
    }

    recordPerfMetric({
      kind: 'db',
      name: 'search-document-count',
      durationMs: nowMs() - startedAt,
      value: count,
      tags: { extName, type: args.type, entityType, folderId, sourceKey },
    });
    return count;
  }

  async extGetSearchDocumentFolderFacets(
    extName: string,
    args: { type?: ExtensionType; entityType?: ResultEntityType } = {},
  ): Promise<SearchDocumentFolderFacetSummary> {
    const startedAt = nowMs();
    const entityType = args.entityType ?? entityTypeFromExtensionType(args.type);
    const statusCounts: Record<BookmarkFolderStatus, number> = {
      'api-name': 0,
      'id-only': 0,
      none: 0,
    };
    const counters = new Map<string, SearchDocumentFolderFacet>();
    let totalDocuments = 0;

    const collection = entityType
      ? this.searchDocuments().where('[extension_name+entity_type]').equals([extName, entityType])
      : this.searchDocuments().where('extension_name').equals(extName);

    await collection
      .each((row) => {
        totalDocuments += 1;
        const status = getBookmarkFolderStatus(row);
        statusCounts[status] += 1;
        const folderId = String(row.folder_id || '').trim();
        if (!folderId) return;
        const folderName = String(row.folder_name || '').trim();
        const existing = counters.get(folderId);
        if (existing) {
          existing.count += 1;
          if (folderName && existing.status !== 'api-name') {
            existing.label = folderName;
            existing.status = 'api-name';
          }
          return;
        }
        counters.set(folderId, {
          folderId,
          label: folderName || `Folder ${folderId}`,
          count: 1,
          status,
        });
      })
      .catch(this.logError);

    const facets = [...counters.values()].sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.label.localeCompare(right.label);
    });

    recordPerfMetric({
      kind: 'db',
      name: 'search-document-folder-facets',
      durationMs: nowMs() - startedAt,
      value: facets.length,
      tags: { extName, type: args.type, entityType, totalDocuments },
    });

    return { totalDocuments, statusCounts, facets };
  }

  async extGetSearchDocumentFolderCursorPage(
    extName: string,
    args: {
      type?: ExtensionType;
      entityType?: ResultEntityType;
      folderId: string;
      after?: SearchDocumentResultCursor;
      before?: SearchDocumentResultCursor;
      limit?: number;
      order?: 'newest' | 'oldest';
    },
  ): Promise<SearchDocumentCursorPage> {
    const startedAt = nowMs();
    const entityType = args.entityType ?? entityTypeFromExtensionType(args.type);
    const folderId = String(args.folderId || '').trim();
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
    const order = args.order ?? 'newest';
    if (!entityType || !folderId) {
      return { documents: [], hasBefore: false, hasAfter: false };
    }

    const minKey = [
      extName,
      entityType,
      folderId,
      MIN_TIME_INDEX_KEY,
      MIN_STRING_INDEX_KEY,
    ] as IndexableType[];
    const maxKey = [
      extName,
      entityType,
      folderId,
      MAX_TIME_INDEX_KEY,
      MAX_STRING_INDEX_KEY,
    ] as IndexableType[];
    let lower = minKey;
    let upper = maxKey;
    let includeLower = true;
    let includeUpper = true;
    const cursor = args.after ?? args.before;

    if (cursor) {
      const cursorKey = [
        extName,
        entityType,
        folderId,
        cursor.observedAtMs,
        cursor.documentId,
      ] as IndexableType[];
      if (args.before) {
        if (order === 'newest') {
          lower = cursorKey;
          includeLower = false;
        } else {
          upper = cursorKey;
          includeUpper = false;
        }
      } else if (order === 'newest') {
        upper = cursorKey;
        includeUpper = false;
      } else {
        lower = cursorKey;
        includeLower = false;
      }
    }

    let collection = this.searchDocuments()
      .where('[extension_name+entity_type+folder_id+observed_at_ms+id]')
      .between(lower, upper, includeLower, includeUpper);
    if (order === 'newest') {
      collection = collection.reverse();
    }

    const rows =
      (await collection
        .limit(limit + 1)
        .toArray()
        .catch(this.logError)) ?? [];
    const documents = rows.slice(0, limit);
    const result: SearchDocumentCursorPage = {
      documents,
      cursorBefore: searchDocumentCursorFromRow(documents[0]),
      cursorAfter: searchDocumentCursorFromRow(documents[documents.length - 1]),
      hasBefore: Boolean(args.after || args.before),
      hasAfter: rows.length > limit,
    };

    recordPerfMetric({
      kind: 'db',
      name: 'search-document-folder-cursor-page',
      durationMs: nowMs() - startedAt,
      value: documents.length,
      tags: {
        extName,
        type: args.type,
        entityType,
        folderId,
        limit,
        order,
        hasAfter: result.hasAfter,
      },
    });
    return result;
  }

  async extGetSearchDocumentFolderPage(
    extName: string,
    args: {
      type?: ExtensionType;
      entityType?: ResultEntityType;
      folderId: string;
      offset?: number;
      limit?: number;
      order?: 'newest' | 'oldest';
    },
  ): Promise<SearchDocumentCursorPage> {
    const startedAt = nowMs();
    const entityType = args.entityType ?? entityTypeFromExtensionType(args.type);
    const folderId = String(args.folderId || '').trim();
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
    const order = args.order ?? 'newest';
    if (!entityType || !folderId) {
      return { documents: [], hasBefore: false, hasAfter: false };
    }

    const minKey = [
      extName,
      entityType,
      folderId,
      MIN_TIME_INDEX_KEY,
      MIN_STRING_INDEX_KEY,
    ] as IndexableType[];
    const maxKey = [
      extName,
      entityType,
      folderId,
      MAX_TIME_INDEX_KEY,
      MAX_STRING_INDEX_KEY,
    ] as IndexableType[];
    let collection = this.searchDocuments()
      .where('[extension_name+entity_type+folder_id+observed_at_ms+id]')
      .between(minKey, maxKey, true, true);
    if (order === 'newest') {
      collection = collection.reverse();
    }

    const rows =
      (await collection
        .offset(offset)
        .limit(limit + 1)
        .toArray()
        .catch(this.logError)) ?? [];
    const documents = rows.slice(0, limit);
    const result: SearchDocumentCursorPage = {
      documents,
      cursorBefore: searchDocumentCursorFromRow(documents[0]),
      cursorAfter: searchDocumentCursorFromRow(documents[documents.length - 1]),
      hasBefore: offset > 0,
      hasAfter: rows.length > limit,
    };

    recordPerfMetric({
      kind: 'db',
      name: 'search-document-folder-page',
      durationMs: nowMs() - startedAt,
      value: documents.length,
      tags: {
        extName,
        type: args.type,
        entityType,
        folderId,
        offset,
        limit,
        order,
        hasAfter: result.hasAfter,
      },
    });
    return result;
  }

  private searchDocumentHasMedia(row: SearchDocumentRow): boolean {
    return Boolean(
      row.flags_json?.has_media ||
      Number(row.numeric_json?.media_count || 0) > 0 ||
      Number(row.media_flag || 0) > 0,
    );
  }

  private async getSearchDocumentMediaScanRows(
    extName: string,
    entityType: ResultEntityType,
    folderIds: Set<string>,
    order: 'newest' | 'oldest',
  ): Promise<SearchDocumentRow[]> {
    const rows =
      (await this.searchDocuments()
        .where('[extension_name+entity_type]')
        .equals([extName, entityType])
        .filter((row) => {
          if (folderIds.size && !folderIds.has(String(row.folder_id || '').trim())) {
            return false;
          }
          return this.searchDocumentHasMedia(row);
        })
        .toArray()
        .catch(this.logError)) ?? [];
    rows.sort((left, right) => {
      const leftObserved = Number(left.observed_at_ms || 0);
      const rightObserved = Number(right.observed_at_ms || 0);
      if (leftObserved !== rightObserved) {
        return order === 'newest' ? rightObserved - leftObserved : leftObserved - rightObserved;
      }
      return order === 'newest'
        ? String(right.id).localeCompare(String(left.id))
        : String(left.id).localeCompare(String(right.id));
    });
    return rows;
  }

  private async repairSearchDocumentMediaIndexes(rows: SearchDocumentRow[]): Promise<void> {
    const repairs = rows
      .filter(
        (row) =>
          this.searchDocumentHasMedia(row) &&
          (Number(row.media_flag || 0) !== 1 ||
            Number(row.numeric_json?.media_count || 0) <= 0 ||
            row.flags_json?.has_media !== true),
      )
      .map((row) => ({
        ...row,
        media_flag: 1,
        flags_json: {
          ...(row.flags_json ?? {}),
          has_media: true,
        },
        numeric_json: {
          ...(row.numeric_json ?? {}),
          media_count: Math.max(1, Number(row.numeric_json?.media_count || 0)),
        },
      }));
    if (!repairs.length) return;
    await this.upsertSearchDocuments(repairs);
  }

  async extGetSearchDocumentMediaCount(
    extName: string,
    args: {
      entityType?: ResultEntityType;
      folderIds?: string[];
    } = {},
  ) {
    const startedAt = nowMs();
    const entityType = args.entityType ?? 'tweet';
    const folderIds = new Set(
      (args.folderIds ?? []).map((folderId) => folderId.trim()).filter(Boolean),
    );
    const countFromMediaFlag =
      (await this.searchDocuments()
        .where('[extension_name+entity_type+media_flag+observed_at_ms+id]')
        .between(
          [extName, entityType, 1, MIN_TIME_INDEX_KEY, MIN_STRING_INDEX_KEY],
          [extName, entityType, 1, MAX_TIME_INDEX_KEY, MAX_STRING_INDEX_KEY],
          true,
          true,
        )
        .filter((row) => !folderIds.size || folderIds.has(String(row.folder_id || '').trim()))
        .count()
        .catch(this.logError)) ?? 0;
    const fallbackCount =
      (await this.searchDocuments()
        .where('[extension_name+entity_type+numeric_json.media_count+observed_at_ms+id]')
        .between(
          [extName, entityType, 1, MIN_TIME_INDEX_KEY, MIN_STRING_INDEX_KEY],
          [extName, entityType, MAX_TIME_INDEX_KEY, MAX_TIME_INDEX_KEY, MAX_STRING_INDEX_KEY],
          true,
          true,
        )
        .filter((row) => !folderIds.size || folderIds.has(String(row.folder_id || '').trim()))
        .count()
        .catch(this.logError)) ?? 0;
    const scannedRows = await this.getSearchDocumentMediaScanRows(
      extName,
      entityType,
      folderIds,
      'newest',
    );
    const scanCount = scannedRows.length;
    const indexedCount = Math.max(countFromMediaFlag, fallbackCount);
    if (scanCount > indexedCount) {
      await this.repairSearchDocumentMediaIndexes(scannedRows);
    }
    const fallbackMode =
      scanCount > indexedCount
        ? 'legacy_flags_scan'
        : countFromMediaFlag
          ? 'media_flag'
          : fallbackCount
            ? 'numeric_json'
            : 'none';
    const count = Math.max(indexedCount, scanCount);

    recordPerfMetric({
      kind: 'db',
      name: 'search-document-media-count',
      durationMs: nowMs() - startedAt,
      value: count,
      tags: { extName, entityType, folderIds: [...folderIds].join(','), fallbackMode },
    });
    return count;
  }

  async extGetSearchDocumentMediaCursorPage(
    extName: string,
    args: {
      entityType?: ResultEntityType;
      folderIds?: string[];
      after?: SearchDocumentResultCursor;
      before?: SearchDocumentResultCursor;
      offset?: number;
      limit?: number;
      order?: 'newest' | 'oldest';
    } = {},
  ): Promise<SearchDocumentCursorPage> {
    const startedAt = nowMs();
    const entityType = args.entityType ?? 'tweet';
    const folderIds = new Set(
      (args.folderIds ?? []).map((folderId) => folderId.trim()).filter(Boolean),
    );
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const order = args.order ?? 'newest';

    const minKey = [
      extName,
      entityType,
      1,
      MIN_TIME_INDEX_KEY,
      MIN_STRING_INDEX_KEY,
    ] as IndexableType[];
    const maxKey = [
      extName,
      entityType,
      1,
      MAX_TIME_INDEX_KEY,
      MAX_STRING_INDEX_KEY,
    ] as IndexableType[];
    let lower = minKey;
    let upper = maxKey;
    let includeLower = true;
    let includeUpper = true;
    const cursor = args.after ?? args.before;

    if (cursor) {
      const cursorKey = [
        extName,
        entityType,
        1,
        cursor.observedAtMs,
        cursor.documentId,
      ] as IndexableType[];
      if (args.before) {
        if (order === 'newest') {
          lower = cursorKey;
          includeLower = false;
        } else {
          upper = cursorKey;
          includeUpper = false;
        }
      } else if (order === 'newest') {
        upper = cursorKey;
        includeUpper = false;
      } else {
        lower = cursorKey;
        includeLower = false;
      }
    }

    let collection = this.searchDocuments()
      .where('[extension_name+entity_type+media_flag+observed_at_ms+id]')
      .between(lower, upper, includeLower, includeUpper)
      .filter((row) => !folderIds.size || folderIds.has(String(row.folder_id || '').trim()));
    if (order === 'newest') {
      collection = collection.reverse();
    }

    let usedFallback = false;
    let rows =
      (await collection
        .offset(cursor ? 0 : offset)
        .limit(limit + 1)
        .toArray()
        .catch(this.logError)) ?? [];
    if (!rows.length && !cursor) {
      usedFallback = true;
      const fallbackMinKey = [
        extName,
        entityType,
        1,
        MIN_TIME_INDEX_KEY,
        MIN_STRING_INDEX_KEY,
      ] as IndexableType[];
      const fallbackMaxKey = [
        extName,
        entityType,
        MAX_TIME_INDEX_KEY,
        MAX_TIME_INDEX_KEY,
        MAX_STRING_INDEX_KEY,
      ] as IndexableType[];
      let fallbackCollection = this.searchDocuments()
        .where('[extension_name+entity_type+numeric_json.media_count+observed_at_ms+id]')
        .between(fallbackMinKey, fallbackMaxKey, true, true)
        .filter((row) => !folderIds.size || folderIds.has(String(row.folder_id || '').trim()));
      if (order === 'newest') {
        fallbackCollection = fallbackCollection.reverse();
      }
      rows =
        (await fallbackCollection
          .offset(offset)
          .limit(limit + 1)
          .toArray()
          .catch(this.logError)) ?? [];
    }
    const fallbackMode = usedFallback ? 'numeric_json' : 'media_flag';
    const documents = rows.slice(0, limit);
    const result: SearchDocumentCursorPage = {
      documents,
      cursorBefore: searchDocumentCursorFromRow(documents[0]),
      cursorAfter: searchDocumentCursorFromRow(documents[documents.length - 1]),
      hasBefore: Boolean(args.after || args.before || offset > 0),
      hasAfter: rows.length > limit,
    };

    recordPerfMetric({
      kind: 'db',
      name: 'search-document-media-cursor-page',
      durationMs: nowMs() - startedAt,
      value: documents.length,
      tags: {
        extName,
        entityType,
        folderIds: [...folderIds].join(','),
        offset: cursor ? 0 : offset,
        limit,
        order,
        hasAfter: result.hasAfter,
        fallback: usedFallback,
        fallbackMode,
      },
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
      await this.invalidateCaptureIndexPages(extName, ExtensionType.TWEET);
      await this.invalidateFolderSourceIndexPages(extName);

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
      await this.invalidateCaptureIndexPages(extName, ExtensionType.USER);
      await this.invalidateFolderSourceIndexPages(extName);

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
      await this.invalidateCaptureIndexPages(extName, ExtensionType.CUSTOM);
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
        },
      );
      await this.invalidateCaptureIndexPages(extName, ExtensionType.TWEET);
      await this.invalidateFolderSourceIndexPages(extName);
      emitDatabaseMutation({
        extension: extName,
        operation: 'extAddTweetCaptureIds',
        count: ids.length,
        keys: ids,
      });
      void this.publishCaptureCountSnapshot(extName);
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
    await this.invalidateCaptureIndexPages(extName, ExtensionType.TWEET);
    await this.invalidateFolderSourceIndexPages(extName);

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
    await this.invalidateCaptureIndexPages(extName, ExtensionType.USER);
    await this.invalidateFolderSourceIndexPages(extName);

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
    await this.invalidateCaptureIndexPages(extName, ExtensionType.USER);
    await this.invalidateFolderSourceIndexPages(extName);

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
    await this.invalidateFolderSourceIndexPages();

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
    await this.invalidateCaptureIndexPages(extName);
    await this.invalidateFolderSourceIndexPages(extName);
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

    const result = await this.db
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
    if (result.updated > 0) {
      await this.invalidateFolderSourceIndexPages(extName);
    }
    return result;
  }

  /*
  |--------------------------------------------------------------------------
  | Export and Import Methods
  |--------------------------------------------------------------------------
  */

  async export() {
    return exportDB(this.db).catch(this.logError);
  }

  async import(data: Blob, options: Pick<ImportOptions, 'progressCallback'> = {}) {
    const result = await importInto(this.db, data, {
      acceptMissingTables: true,
      acceptVersionDiff: true,
      progressCallback: options.progressCallback,
    }).catch((error) => {
      this.logError(error, 'import');
      throw error;
    });
    this.bumpAllCaptureIndexRevisions();
    await this.deleteAllCaptureIndexPages();
    await this.invalidateFolderSourceIndexPages();
    emitDatabaseMutation({
      operation: 'import',
    });
    this.publishCaptureCountSnapshotForAllKnownExtensions();
    return result;
  }

  async clear() {
    this.bumpAllCaptureIndexRevisions();
    await this.deleteAllCaptures();
    await this.deleteAllCaptureIndexPages();
    await this.deleteAllSocialEdges();
    await this.deleteAllSearchDocuments();
    await this.invalidateFolderSourceIndexPages();
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
        folder_source_index_pages: await this.folderSourceIndexPages().count(),
      };
    } catch (error) {
      this.logError(error);
      return null;
    }
  }

  async publishKnownCaptureCountSnapshot(extName: string, count: number): Promise<void> {
    await this.writeCaptureCountSnapshot(extName, Math.max(0, Math.floor(Number(count) || 0)));
  }

  private async publishCaptureCountSnapshot(extName: string): Promise<void> {
    try {
      const count = Number((await this.extGetCaptureCount(extName)) || 0);
      await this.writeCaptureCountSnapshot(extName, count);
    } catch {
      // ignore snapshot failures
    }
  }

  private async writeCaptureCountSnapshot(extName: string, count: number): Promise<void> {
    try {
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
      const mediaCount = extractTweetMedia(tweet).length;
      const hasMedia = mediaCount > 0;
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
        media_flag: hasMedia ? 1 : 0,
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
          media_count: mediaCount,
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
      const mediaCount = Number(readPath(projected, 'twe_private_fields.media_count') || 0);
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
        media_flag: mediaCount > 0 ? 1 : 0,
        exact_json: {
          folder: [folderId, folderName].filter(Boolean),
        },
        numeric_json: {
          media_count: mediaCount,
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
    const extensionNames = this.searchDocumentExtensionNames(rows);
    return this.enqueueWrite('upsertSearchDocuments', async () => {
      const result = await this.db.transaction('rw', this.searchDocuments(), async () => {
        await this.bulkPutInChunks(this.searchDocuments(), rows);
      });
      await this.invalidateFolderSourceIndexPagesForExtensions(extensionNames);
      recordPerfMetric({
        kind: 'db',
        name: 'search-documents-upsert',
        durationMs: nowMs() - startedAt,
        value: rows.length,
      });
      return result;
    });
  }

  async putSyntheticSeedRows(rows: SyntheticSeedBulkRows) {
    const users = rows.users ?? [];
    const tweets = rows.tweets ?? [];
    const captures = rows.captures ?? [];
    const searchDocuments = rows.searchDocuments ?? [];
    const totalRows = users.length + tweets.length + captures.length + searchDocuments.length;
    if (!totalRows) return;

    const startedAt = nowMs();
    const searchDocumentExtensionNames = this.searchDocumentExtensionNames(searchDocuments);
    return this.enqueueWrite('putSyntheticSeedRows', async () => {
      const result = await this.db.transaction(
        'rw',
        this.users(),
        this.tweets(),
        this.captures(),
        this.searchDocuments(),
        async () => {
          if (users.length) await this.bulkPutInChunks(this.users(), users);
          if (tweets.length) await this.bulkPutInChunks(this.tweets(), tweets);
          if (captures.length) await this.bulkPutInChunks(this.captures(), captures);
          if (searchDocuments.length) {
            await this.bulkPutInChunks(this.searchDocuments(), searchDocuments);
          }
        },
      );
      if (captures.length) {
        await this.invalidateCaptureIndexPagesForRows(captures);
      }
      await this.invalidateFolderSourceIndexPagesForExtensions(searchDocumentExtensionNames);
      recordPerfMetric({
        kind: 'db',
        name: 'synthetic-seed-bulk-put',
        durationMs: nowMs() - startedAt,
        value: totalRows,
        tags: {
          users: users.length,
          tweets: tweets.length,
          captures: captures.length,
          searchDocuments: searchDocuments.length,
        },
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
      await this.invalidateCaptureIndexPagesForRows(captures);
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
    this.bumpAllCaptureIndexRevisions();
    await this.deleteAllCaptureIndexPages();
    return this.captures().clear().catch(this.logError);
  }

  async deleteAllCaptureIndexPages() {
    return this.captureIndexPages().clear().catch(this.logError);
  }

  async deleteAllSocialEdges() {
    return this.socialEdges().clear().catch(this.logError);
  }

  async deleteAllSearchDocuments() {
    await this.invalidateFolderSourceIndexPages();
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
    await this.invalidateFolderSourceIndexPages();

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
      '[extension+type+created_at+id]',
    ] as Array<KeyPaths<Capture> | string>;

    const captureIndexPageIndexPaths = [
      'id',
      'extension',
      'type',
      'order',
      'source_count',
      'page_start',
      '[extension+type+order+source_count+page_start]',
    ] as Array<KeyPaths<CaptureIndexPageRow> | string>;

    const folderSourceIndexPageIndexPaths = [
      'id',
      'source_hash',
      'source_key',
      'extension_name',
      'entity_type',
      'source_count',
      'source_revision',
      'page_start',
      '[source_hash+source_count+source_revision+page_start]',
    ] as Array<KeyPaths<FolderSourceIndexPageRow> | string>;

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
      'media_flag',
      'numeric_json.media_count',
      '[source_key+entity_type]',
      '[extension_name+entity_type]',
      '[extension_name+entity_type+media_flag+observed_at_ms+id]',
      '[extension_name+entity_type+numeric_json.media_count+observed_at_ms+id]',
      '[extension_name+entity_type+folder_id+observed_at_ms]',
      '[extension_name+entity_type+folder_id+observed_at_ms+id]',
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
        capture_index_pages: captureIndexPageIndexPaths.join(','),
        folder_source_index_pages: folderSourceIndexPageIndexPaths.join(','),
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
