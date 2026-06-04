import { db } from '@/core/database';
import type { SearchDocumentRow } from '@/core/database/manager';
import { ExtensionType } from '@/core/extensions/extension';
import { nowMs, recordPerfMetric } from '@/core/perf/metrics';
import type { Capture, Tweet, User } from '@/types';
import {
  createCaptureResultSourceDescriptor,
  createFolderResultSourceDescriptor,
  createMediaResultSourceDescriptor,
  serializeResultSourceDescriptor,
  type CaptureResultCursor,
  type ResultEntityType,
  type ResultSource,
  type ResultWindow,
  type ResultWindowRequest,
  type SearchDocumentResultCursor,
} from './result-source';
import { recordResultSourceDiagnostics } from './result-source-diagnostics';

const DEFAULT_PAGE_SIZE = 160;
const DEFAULT_CACHE_PAGE_LIMIT = 10;
const MERGED_FOLDER_PAGE_BATCH_SIZE = 1000;
const CHECKPOINT_MAX_WALK_ROWS = 5000;
const FOLDER_SOURCE_INDEX_PAGE_SIZE = 256;
const FOLDER_SOURCE_INDEX_BACKGROUND_BUILD_MIN_COUNT = 1000;
const FOLDER_SOURCE_INDEX_BACKGROUND_BUILD_DELAY_MS = 1500;
const CAPTURE_COUNT_SNAPSHOT_V2_KEY = '__twe_capture_counts_v2';
const ACTIVE_DB_NAME_KEY = '__twe_active_db_name_v1';

type LiveCaptureRow = Tweet | User;

type PageCacheEntry<Row, Cursor> = {
  key: string;
  value: ResultWindow<Row, Cursor>;
  touchedAt: number;
};

type SparseCheckpoint<Cursor> = {
  index: number;
  cursorAfter?: Cursor;
};

type CaptureCountSnapshotCandidate = {
  count: number;
  dbName: string;
  updatedAt: number;
};

class LruPageCache<Row, Cursor> {
  private readonly entries = new Map<string, PageCacheEntry<Row, Cursor>>();

  constructor(private readonly maxPages = DEFAULT_CACHE_PAGE_LIMIT) {}

  get(key: string): ResultWindow<Row, Cursor> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.touchedAt = Date.now();
    return entry.value;
  }

  set(key: string, value: ResultWindow<Row, Cursor>): void {
    this.entries.set(key, { key, value, touchedAt: Date.now() });
    if (this.entries.size <= this.maxPages) return;

    const oldest = [...this.entries.values()].sort(
      (left, right) => left.touchedAt - right.touchedAt,
    );
    for (const entry of oldest.slice(0, Math.max(0, this.entries.size - this.maxPages))) {
      this.entries.delete(entry.key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get rowCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      count += entry.value.rows.length;
    }
    return count;
  }
}

function rememberCheckpoint<Cursor>(
  checkpoints: Map<number, SparseCheckpoint<Cursor>>,
  index: number,
  cursorAfter?: Cursor,
): void {
  const normalizedIndex = Math.max(0, Math.floor(Number(index) || 0));
  if (normalizedIndex > 0 && !cursorAfter) return;
  checkpoints.set(normalizedIndex, { index: normalizedIndex, cursorAfter });
}

function nearestCheckpointBefore<Cursor>(
  checkpoints: Map<number, SparseCheckpoint<Cursor>>,
  startIndex: number,
): SparseCheckpoint<Cursor> | null {
  let best: SparseCheckpoint<Cursor> | null = null;
  for (const checkpoint of checkpoints.values()) {
    if (checkpoint.index > startIndex) continue;
    if (!best || checkpoint.index > best.index) {
      best = checkpoint;
    }
  }
  if (!best || startIndex - best.index > CHECKPOINT_MAX_WALK_ROWS) return null;
  return best;
}

function requestCacheKey<Cursor>(request: ResultWindowRequest<Cursor>): string {
  return JSON.stringify({
    startIndex: request.startIndex ?? 0,
    limit: request.limit,
    after: request.after ?? null,
    before: request.before ?? null,
    direction: request.direction ?? 'forward',
  });
}

function normalizeFolderIds(folderIds: string[]): string[] {
  return [...new Set(folderIds.map((folderId) => folderId.trim()).filter(Boolean))].sort();
}

function readActiveDatabaseName(): string {
  try {
    const raw = localStorage.getItem(ACTIVE_DB_NAME_KEY);
    return raw?.trim() ?? '';
  } catch {
    return '';
  }
}

function readCaptureCountSnapshot(extName: string): number | null {
  const candidates: CaptureCountSnapshotCandidate[] = [];
  const activeDbName = readActiveDatabaseName();

  const collect = (root: unknown) => {
    if (!root || typeof root !== 'object') return;
    const snapshots = (root as Record<string, unknown>)[CAPTURE_COUNT_SNAPSHOT_V2_KEY];
    if (!snapshots || typeof snapshots !== 'object') return;
    const entry = (snapshots as Record<string, unknown>)[extName];
    if (!entry || typeof entry !== 'object') return;
    const obj = entry as Record<string, unknown>;
    const count = Number(obj.count);
    if (!Number.isFinite(count) || count < 0) return;
    const dbName = typeof obj.dbName === 'string' ? obj.dbName : '';
    const updatedAt = Number(obj.updatedAt);
    candidates.push({
      count: Math.floor(count),
      dbName,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    });
  };

  try {
    collect(globalThis);
  } catch {
    // ignore
  }
  try {
    if (typeof window !== 'undefined') {
      collect(window);
    }
  } catch {
    // ignore
  }
  try {
    const raw = localStorage.getItem(CAPTURE_COUNT_SNAPSHOT_V2_KEY);
    if (raw) {
      collect({ [CAPTURE_COUNT_SNAPSHOT_V2_KEY]: JSON.parse(raw) });
    }
  } catch {
    // ignore
  }

  const scoped = activeDbName
    ? candidates.filter((candidate) => candidate.dbName === activeDbName)
    : candidates;
  const pool = scoped.length ? scoped : candidates;
  pool.sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    return right.count - left.count;
  });
  return pool[0]?.count ?? null;
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

function captureCursorFromRow(row: Capture | undefined): CaptureResultCursor | undefined {
  if (!row) return undefined;
  return {
    createdAt: Number(row.created_at) || 0,
    captureId: row.id,
  };
}

function compareSearchDocumentsNewest(left: SearchDocumentRow, right: SearchDocumentRow): number {
  const leftTime = Number(left.observed_at_ms || left.created_at_ms || left.updated_at_ms) || 0;
  const rightTime = Number(right.observed_at_ms || right.created_at_ms || right.updated_at_ms) || 0;
  if (rightTime !== leftTime) return rightTime - leftTime;
  return right.id.localeCompare(left.id);
}

function uniqueSearchDocuments(rows: SearchDocumentRow[]): SearchDocumentRow[] {
  const seen = new Set<string>();
  const out: SearchDocumentRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

async function hydrateLiveCaptureRows(
  type: ExtensionType,
  ids: string[],
): Promise<LiveCaptureRow[]> {
  if (type === ExtensionType.USER) {
    return ((await db.extGetUsersByIds(ids)) ?? []) as User[];
  }
  return ((await db.extGetTweetsByIds(ids)) ?? []) as Tweet[];
}

async function hydrateLiveEntityRows(
  entityType: ResultEntityType,
  ids: string[],
): Promise<LiveCaptureRow[]> {
  if (entityType === 'user') {
    return ((await db.extGetUsersByIds(ids)) ?? []) as User[];
  }
  if (entityType === 'tweet') {
    return ((await db.extGetTweetsByIds(ids)) ?? []) as Tweet[];
  }
  return [];
}

export function createLiveCapturesResultSource(args: {
  extensionName: string;
  extensionType: ExtensionType;
  cachePages?: number;
}): ResultSource<LiveCaptureRow, CaptureResultCursor> {
  const descriptor = createCaptureResultSourceDescriptor({
    extensionName: args.extensionName,
    extensionType: args.extensionType,
    direction: 'desc',
  });
  const cache = new LruPageCache<LiveCaptureRow, CaptureResultCursor>(
    args.cachePages ?? DEFAULT_CACHE_PAGE_LIMIT,
  );
  const checkpoints = new Map<number, SparseCheckpoint<CaptureResultCursor>>();
  rememberCheckpoint(checkpoints, 0);
  const key = serializeResultSourceDescriptor(descriptor);
  let cachedTotalCount = readCaptureCountSnapshot(args.extensionName);
  let totalCountPromise: Promise<number> | null = null;

  const totalCount = async () => {
    const snapshotCount = readCaptureCountSnapshot(args.extensionName);
    if (snapshotCount !== null) {
      cachedTotalCount = snapshotCount;
      return snapshotCount;
    }
    if (cachedTotalCount !== null) return cachedTotalCount;
    if (!totalCountPromise) {
      totalCountPromise = db
        .extGetCaptureCount(args.extensionName, args.extensionType)
        .then((count) => Number(count) || 0)
        .finally(() => {
          totalCountPromise = null;
        });
    }
    cachedTotalCount = await totalCountPromise;
    return cachedTotalCount;
  };

  const getCheckpointCapturePage = async (startIndex: number, limit: number) => {
    const checkpoint = nearestCheckpointBefore(checkpoints, startIndex);
    if (!checkpoint) return null;

    const targetEnd = startIndex + limit;
    let currentIndex = checkpoint.index;
    let cursor = checkpoint.cursorAfter;
    let hasAfter = false;
    const captures: Capture[] = [];

    while (currentIndex < targetEnd) {
      const page = await db.extGetCaptureIdsCursorPage(args.extensionName, {
        type: args.extensionType,
        after: cursor,
        limit: Math.min(1000, Math.max(1, targetEnd - currentIndex)),
        order: 'newest',
      });
      if (!page.captures.length) {
        hasAfter = false;
        break;
      }

      const pageStart = currentIndex;
      const pageEnd = currentIndex + page.captures.length;
      const sliceStart = Math.max(0, startIndex - pageStart);
      const sliceEnd = Math.max(sliceStart, Math.min(page.captures.length, targetEnd - pageStart));
      captures.push(...page.captures.slice(sliceStart, sliceEnd));

      currentIndex = pageEnd;
      cursor = page.cursorAfter;
      hasAfter = page.hasAfter;
      rememberCheckpoint(checkpoints, currentIndex, cursor);

      if (!page.hasAfter || pageEnd <= pageStart) break;
    }

    return {
      captures,
      cursorBefore: captureCursorFromRow(captures[0]),
      cursorAfter: captureCursorFromRow(captures[captures.length - 1]),
      hasBefore: startIndex > 0,
      hasAfter: hasAfter || currentIndex > targetEnd,
    };
  };

  const getWindow = async (
    request: ResultWindowRequest<CaptureResultCursor>,
  ): Promise<ResultWindow<LiveCaptureRow, CaptureResultCursor>> => {
    const startedAt = performance.now();
    const limit = Math.max(1, Math.min(1000, Number(request.limit) || DEFAULT_PAGE_SIZE));
    const normalizedRequest: ResultWindowRequest<CaptureResultCursor> = {
      ...request,
      limit,
      direction: request.direction ?? 'forward',
    };
    const cacheKey = requestCacheKey(normalizedRequest);
    const cached = cache.get(cacheKey);
    if (cached) {
      recordResultSourceDiagnostics({
        sourceKey: key,
        descriptor,
        totalCount: cached.totalCount,
        cachedPages: cache.size,
        cachedRows: cache.rowCount,
        lastFetchDurationMs: performance.now() - startedAt,
        lastWindowRows: cached.rows.length,
        lastWindowStartIndex: cached.startIndex,
        lastCacheHit: true,
      });
      return cached;
    }

    const totalCountRequest = totalCount();
    let captureIds: string[] = [];
    let cursorBefore: CaptureResultCursor | undefined;
    let cursorAfter: CaptureResultCursor | undefined;
    let hasBefore = false;
    let hasAfter = false;
    let totalCountValue: number | null = null;

    if (normalizedRequest.after || normalizedRequest.before) {
      const page = await db.extGetCaptureIdsCursorPage(args.extensionName, {
        type: args.extensionType,
        after: normalizedRequest.after,
        before: normalizedRequest.before,
        limit,
        order: 'newest',
      });
      captureIds = page.ids;
      cursorBefore = page.cursorBefore;
      cursorAfter = page.cursorAfter;
      hasBefore = page.hasBefore;
      hasAfter = page.hasAfter;
    } else {
      const offset = Math.max(0, Math.floor(Number(normalizedRequest.startIndex) || 0));
      totalCountValue = await totalCountRequest;
      const indexedCaptureIds = await db.extGetCaptureIdsIndexedPage(args.extensionName, {
        type: args.extensionType,
        offset,
        limit,
        order: 'newest',
        sourceCount: totalCountValue,
      });
      if (indexedCaptureIds) {
        captureIds = indexedCaptureIds;
        hasBefore = offset > 0;
        hasAfter = offset + captureIds.length < totalCountValue;
      } else {
        const checkpointPage = await getCheckpointCapturePage(offset, limit);
        if (checkpointPage) {
          captureIds = checkpointPage.captures.map((capture) => capture.data_key).filter(Boolean);
          cursorBefore = checkpointPage.cursorBefore;
          cursorAfter = checkpointPage.cursorAfter;
          hasBefore = checkpointPage.hasBefore;
          hasAfter = checkpointPage.hasAfter;
        } else {
          captureIds = await db.extGetCaptureIdsPage(args.extensionName, {
            type: args.extensionType,
            offset,
            limit,
            order: 'newest',
          });
          hasBefore = offset > 0;
        }
      }
    }

    totalCountValue ??= await totalCountRequest;
    if (!hasAfter) {
      const offset = Math.max(0, Math.floor(Number(normalizedRequest.startIndex) || 0));
      hasAfter = offset + captureIds.length < totalCountValue;
    }
    const rows = await hydrateLiveCaptureRows(args.extensionType, captureIds);
    const window: ResultWindow<LiveCaptureRow, CaptureResultCursor> = {
      source: descriptor,
      totalCount: totalCountValue,
      startIndex: normalizedRequest.startIndex,
      rows,
      rowIds: captureIds,
      hasBefore,
      hasAfter,
      cursorBefore,
      cursorAfter,
    };
    rememberCheckpoint(
      checkpoints,
      Math.max(0, Math.floor(Number(normalizedRequest.startIndex) || 0)) + captureIds.length,
      cursorAfter,
    );
    cache.set(cacheKey, window);
    recordResultSourceDiagnostics({
      sourceKey: key,
      descriptor,
      totalCount: totalCountValue,
      cachedPages: cache.size,
      cachedRows: cache.rowCount,
      lastFetchDurationMs: performance.now() - startedAt,
      lastWindowRows: rows.length,
      lastWindowStartIndex: normalizedRequest.startIndex,
      lastCacheHit: false,
    });
    return window;
  };

  return {
    key,
    descriptor,
    totalCount,
    getWindow,
    getByIds: (ids) => hydrateLiveCaptureRows(args.extensionType, ids),
    streamRows: async function* streamRows(streamArgs = {}) {
      let cursor = streamArgs.cursor;
      let startIndex = 0;
      const cursorPaging = Boolean(streamArgs.cursor);
      const batchSize = Math.max(
        1,
        Math.min(1000, Number(streamArgs.batchSize) || DEFAULT_PAGE_SIZE),
      );
      while (!streamArgs.signal?.aborted) {
        const page =
          cursorPaging && cursor
            ? await getWindow({ limit: batchSize, after: cursor })
            : await getWindow({ startIndex, limit: batchSize });
        for (const row of page.rows) {
          if (streamArgs.signal?.aborted) return;
          yield row;
        }
        if (!page.hasAfter || !page.rowIds.length) return;
        startIndex += page.rowIds.length;
        if (page.cursorAfter) {
          cursor = page.cursorAfter;
        } else if (cursorPaging) {
          return;
        }
      }
    },
  };
}

export function createFolderResultSource(args: {
  extensionName: string;
  entityType: ResultEntityType;
  folderId?: string;
  folderIds?: string[];
  knownTotalCount?: number;
  cachePages?: number;
}): ResultSource<LiveCaptureRow, SearchDocumentResultCursor> {
  const folderIds = normalizeFolderIds([
    ...(args.folderIds ?? []),
    ...(args.folderId ? [args.folderId] : []),
  ]);
  const descriptor = createFolderResultSourceDescriptor({
    extensionName: args.extensionName,
    entityType: args.entityType,
    folderIds,
    direction: 'desc',
  });
  const cache = new LruPageCache<LiveCaptureRow, SearchDocumentResultCursor>(
    args.cachePages ?? DEFAULT_CACHE_PAGE_LIMIT,
  );
  const checkpoints = new Map<number, SparseCheckpoint<SearchDocumentResultCursor>>();
  rememberCheckpoint(checkpoints, 0);
  const key = serializeResultSourceDescriptor(descriptor);
  const knownTotalCount =
    typeof args.knownTotalCount === 'number' && Number.isFinite(args.knownTotalCount)
      ? Math.max(0, Math.floor(args.knownTotalCount))
      : null;
  let folderIndexBuildPromise: Promise<boolean> | null = null;

  const totalCount = async () => {
    if (knownTotalCount !== null) return knownTotalCount;
    const counts = await Promise.all(
      folderIds.map((folderId) =>
        db.extGetSearchDocumentCount(args.extensionName, {
          entityType: args.entityType,
          folderId,
        }),
      ),
    );
    return counts.reduce((sum, count) => sum + (Number(count) || 0), 0);
  };

  const getMergedCursorPage = async (
    request: ResultWindowRequest<SearchDocumentResultCursor>,
    limit: number,
  ) => {
    if (folderIds.length === 1) {
      return db.extGetSearchDocumentFolderCursorPage(args.extensionName, {
        entityType: args.entityType,
        folderId: folderIds[0]!,
        after: request.after,
        before: request.before,
        limit,
        order: 'newest',
      });
    }

    const pages = await Promise.all(
      folderIds.map((folderId) =>
        db.extGetSearchDocumentFolderCursorPage(args.extensionName, {
          entityType: args.entityType,
          folderId,
          after: request.after,
          before: request.before,
          limit: limit + 1,
          order: 'newest',
        }),
      ),
    );
    const documents = uniqueSearchDocuments(
      pages.flatMap((page) => page.documents).sort(compareSearchDocumentsNewest),
    ).slice(0, limit);
    return {
      documents,
      cursorBefore: searchDocumentCursorFromRow(documents[0]),
      cursorAfter: searchDocumentCursorFromRow(documents[documents.length - 1]),
      hasBefore: Boolean(request.after || request.before),
      hasAfter:
        pages.some((page) => page.hasAfter) ||
        uniqueSearchDocuments(pages.flatMap((page) => page.documents)).length > limit,
    };
  };

  const getCheckpointFolderPage = async (startIndex: number, limit: number) => {
    const checkpoint = nearestCheckpointBefore(checkpoints, startIndex);
    if (!checkpoint) return null;

    const targetEnd = startIndex + limit;
    let currentIndex = checkpoint.index;
    let cursor = checkpoint.cursorAfter;
    let hasAfter = false;
    const documents: SearchDocumentRow[] = [];

    while (currentIndex < targetEnd) {
      const page = await getMergedCursorPage(
        { after: cursor, limit: Math.min(1000, Math.max(1, targetEnd - currentIndex)) },
        Math.min(1000, Math.max(1, targetEnd - currentIndex)),
      );
      if (!page.documents.length) {
        hasAfter = false;
        break;
      }

      const pageStart = currentIndex;
      const pageEnd = currentIndex + page.documents.length;
      const sliceStart = Math.max(0, startIndex - pageStart);
      const sliceEnd = Math.max(sliceStart, Math.min(page.documents.length, targetEnd - pageStart));
      documents.push(...page.documents.slice(sliceStart, sliceEnd));

      currentIndex = pageEnd;
      cursor = page.cursorAfter;
      hasAfter = page.hasAfter;
      rememberCheckpoint(checkpoints, currentIndex, cursor);

      if (!page.hasAfter || pageEnd <= pageStart) break;
    }

    return {
      documents,
      cursorBefore: searchDocumentCursorFromRow(documents[0]),
      cursorAfter: searchDocumentCursorFromRow(documents[documents.length - 1]),
      hasBefore: startIndex > 0,
      hasAfter,
    };
  };

  const getMergedOffsetPage = async (startIndex: number, limit: number) => {
    if (folderIds.length === 1) {
      return db.extGetSearchDocumentFolderPage(args.extensionName, {
        entityType: args.entityType,
        folderId: folderIds[0]!,
        offset: startIndex,
        limit,
        order: 'newest',
      });
    }

    const target = startIndex + limit + 1;
    const perFolderDocuments = await Promise.all(
      folderIds.map(async (folderId) => {
        const rows: SearchDocumentRow[] = [];
        let offset = 0;
        while (rows.length < target) {
          const page = await db.extGetSearchDocumentFolderPage(args.extensionName, {
            entityType: args.entityType,
            folderId,
            offset,
            limit: Math.min(MERGED_FOLDER_PAGE_BATCH_SIZE, target - rows.length),
            order: 'newest',
          });
          rows.push(...page.documents);
          if (!page.hasAfter || !page.documents.length) break;
          offset += page.documents.length;
        }
        return rows;
      }),
    );
    const merged = uniqueSearchDocuments(
      perFolderDocuments.flat().sort(compareSearchDocumentsNewest),
    );
    const documents = merged.slice(startIndex, startIndex + limit);
    return {
      documents,
      cursorBefore: searchDocumentCursorFromRow(documents[0]),
      cursorAfter: searchDocumentCursorFromRow(documents[documents.length - 1]),
      hasBefore: startIndex > 0,
      hasAfter: merged.length > startIndex + limit,
    };
  };

  const buildFolderSourceIndexPages = async (sourceCount: number): Promise<boolean> => {
    const startedAt = nowMs();
    const expectedCount = Math.max(0, Math.floor(Number(sourceCount) || 0));
    if (!expectedCount) return false;

    const sourceRevision = db.readFolderSourceIndexRevision(args.extensionName);
    const pages: Array<{
      pageStart: number;
      rowIds: string[];
      cursorAfter?: SearchDocumentResultCursor;
    }> = [];
    let pageStart = 0;
    let cursor: SearchDocumentResultCursor | undefined;
    let pendingDocuments: SearchDocumentRow[] = [];

    while (true) {
      const page = await getMergedCursorPage({ after: cursor, limit: 1000 }, 1000);
      pendingDocuments.push(...page.documents);

      while (pendingDocuments.length >= FOLDER_SOURCE_INDEX_PAGE_SIZE) {
        const chunk = pendingDocuments.slice(0, FOLDER_SOURCE_INDEX_PAGE_SIZE);
        pendingDocuments = pendingDocuments.slice(FOLDER_SOURCE_INDEX_PAGE_SIZE);
        pages.push({
          pageStart,
          rowIds: chunk
            .map((document) => document.raw_ref_key || document.entity_id)
            .filter(Boolean),
          cursorAfter: searchDocumentCursorFromRow(chunk[chunk.length - 1]),
        });
        pageStart += FOLDER_SOURCE_INDEX_PAGE_SIZE;
      }

      const currentCursorKey = cursor ? `${cursor.observedAtMs}|${cursor.documentId}` : '';
      const nextCursorKey = page.cursorAfter
        ? `${page.cursorAfter.observedAtMs}|${page.cursorAfter.documentId}`
        : '';
      if (
        !page.hasAfter ||
        !page.cursorAfter ||
        !page.documents.length ||
        nextCursorKey === currentCursorKey
      ) {
        break;
      }
      cursor = page.cursorAfter;
    }

    if (pendingDocuments.length) {
      pages.push({
        pageStart,
        rowIds: pendingDocuments
          .map((document) => document.raw_ref_key || document.entity_id)
          .filter(Boolean),
        cursorAfter: searchDocumentCursorFromRow(pendingDocuments[pendingDocuments.length - 1]),
      });
    }

    const currentCount = await totalCount();
    const currentRevision = db.readFolderSourceIndexRevision(args.extensionName);
    if (currentCount !== expectedCount || currentRevision !== sourceRevision) {
      recordPerfMetric({
        kind: 'db',
        name: 'folder-source-index-build-stale',
        durationMs: nowMs() - startedAt,
        value: pages.length,
        tags: {
          extName: args.extensionName,
          entityType: args.entityType,
          folderCount: folderIds.length,
          expectedCount,
          currentCount,
          sourceRevision,
          currentRevision,
        },
      });
      return false;
    }

    await db.extPutFolderSourceIndexPages({
      sourceKey: key,
      extensionName: args.extensionName,
      entityType: args.entityType,
      folderIds,
      sourceCount: expectedCount,
      sourceRevision,
      pages,
    });
    recordPerfMetric({
      kind: 'db',
      name: 'folder-source-index-build',
      durationMs: nowMs() - startedAt,
      value: pages.length,
      tags: {
        extName: args.extensionName,
        entityType: args.entityType,
        folderCount: folderIds.length,
        sourceCount: expectedCount,
        sourceRevision,
      },
    });
    return true;
  };

  const scheduleFolderSourceIndexBuild = (sourceCount: number): void => {
    const normalizedCount = Math.max(0, Math.floor(Number(sourceCount) || 0));
    if (normalizedCount < FOLDER_SOURCE_INDEX_BACKGROUND_BUILD_MIN_COUNT) return;
    if (folderIndexBuildPromise) return;

    folderIndexBuildPromise = new Promise<boolean>((resolve, reject) => {
      globalThis.setTimeout(() => {
        buildFolderSourceIndexPages(normalizedCount).then(resolve, reject);
      }, FOLDER_SOURCE_INDEX_BACKGROUND_BUILD_DELAY_MS);
    }).finally(() => {
      folderIndexBuildPromise = null;
    });
    void folderIndexBuildPromise.catch((error) => {
      recordPerfMetric({
        kind: 'db',
        name: 'folder-source-index-build-error',
        value: 0,
        tags: {
          extName: args.extensionName,
          entityType: args.entityType,
          folderCount: folderIds.length,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  };

  const getWindow = async (
    request: ResultWindowRequest<SearchDocumentResultCursor>,
  ): Promise<ResultWindow<LiveCaptureRow, SearchDocumentResultCursor>> => {
    const startedAt = performance.now();
    const limit = Math.max(1, Math.min(1000, Number(request.limit) || DEFAULT_PAGE_SIZE));
    const normalizedRequest: ResultWindowRequest<SearchDocumentResultCursor> = {
      ...request,
      limit,
      direction: request.direction ?? 'forward',
    };
    const cacheKey = requestCacheKey(normalizedRequest);
    const cached = cache.get(cacheKey);
    if (cached) {
      recordResultSourceDiagnostics({
        sourceKey: key,
        descriptor,
        totalCount: cached.totalCount,
        cachedPages: cache.size,
        cachedRows: cache.rowCount,
        lastFetchDurationMs: performance.now() - startedAt,
        lastWindowRows: cached.rows.length,
        lastWindowStartIndex: cached.startIndex,
        lastCacheHit: true,
      });
      return cached;
    }

    const offset = Math.max(0, Math.floor(Number(normalizedRequest.startIndex) || 0));
    const totalCountRequest = totalCount();
    let count: number | null = null;
    let rowIds: string[] = [];
    let cursorBefore: SearchDocumentResultCursor | undefined;
    let cursorAfter: SearchDocumentResultCursor | undefined;
    let hasBefore = false;
    let hasAfter = false;
    const isCursorRequest = Boolean(normalizedRequest.after || normalizedRequest.before);

    if (isCursorRequest) {
      const page = await getMergedCursorPage(normalizedRequest, limit);
      rowIds = page.documents
        .map((document) => document.raw_ref_key || document.entity_id)
        .filter(Boolean);
      cursorBefore = page.cursorBefore;
      cursorAfter = page.cursorAfter;
      hasBefore = page.hasBefore;
      hasAfter = page.hasAfter;
    } else {
      count = await totalCountRequest;
      const indexedPage = await db.extGetFolderSourceIndexedPage({
        sourceKey: key,
        extensionName: args.extensionName,
        entityType: args.entityType,
        folderIds,
        sourceCount: count,
        offset,
        limit,
      });

      if (indexedPage) {
        rowIds = indexedPage.rowIds;
        cursorAfter = indexedPage.cursorAfter;
        hasBefore = offset > 0;
        hasAfter = offset + rowIds.length < count;
      } else {
        scheduleFolderSourceIndexBuild(count);
        const page =
          (await getCheckpointFolderPage(offset, limit)) ??
          (await getMergedOffsetPage(offset, limit));
        rowIds = page.documents
          .map((document) => document.raw_ref_key || document.entity_id)
          .filter(Boolean);
        cursorBefore = page.cursorBefore;
        cursorAfter = page.cursorAfter;
        hasBefore = page.hasBefore;
        hasAfter = page.hasAfter;
      }
    }

    count ??= await totalCountRequest;
    if (!isCursorRequest && !hasAfter) {
      hasAfter = offset + rowIds.length < count;
    }
    const rows = await hydrateLiveEntityRows(args.entityType, rowIds);
    const window: ResultWindow<LiveCaptureRow, SearchDocumentResultCursor> = {
      source: descriptor,
      totalCount: count,
      startIndex: normalizedRequest.startIndex,
      rows,
      rowIds,
      hasBefore,
      hasAfter,
      cursorBefore,
      cursorAfter,
    };
    rememberCheckpoint(checkpoints, offset + rowIds.length, cursorAfter);
    cache.set(cacheKey, window);
    recordResultSourceDiagnostics({
      sourceKey: key,
      descriptor,
      totalCount: count,
      cachedPages: cache.size,
      cachedRows: cache.rowCount,
      lastFetchDurationMs: performance.now() - startedAt,
      lastWindowRows: rows.length,
      lastWindowStartIndex: normalizedRequest.startIndex,
      lastCacheHit: false,
    });
    return window;
  };

  return {
    key,
    descriptor,
    totalCount,
    getWindow,
    getByIds: (ids) => hydrateLiveEntityRows(args.entityType, ids),
    streamRows: async function* streamRows(streamArgs = {}) {
      let cursor = streamArgs.cursor;
      let startIndex = 0;
      const cursorPaging = Boolean(streamArgs.cursor);
      const batchSize = Math.max(
        1,
        Math.min(1000, Number(streamArgs.batchSize) || DEFAULT_PAGE_SIZE),
      );
      while (!streamArgs.signal?.aborted) {
        const page =
          cursorPaging && cursor
            ? await getWindow({ limit: batchSize, after: cursor })
            : await getWindow({ startIndex, limit: batchSize });
        for (const row of page.rows) {
          if (streamArgs.signal?.aborted) return;
          yield row;
        }
        if (!page.hasAfter || !page.rows.length) return;
        startIndex += page.rows.length;
        if (page.cursorAfter) {
          cursor = page.cursorAfter;
        } else if (cursorPaging) {
          return;
        }
      }
    },
  };
}

export function createMediaResultSource(args: {
  extensionName: string;
  folderIds?: string[];
  cachePages?: number;
}): ResultSource<Tweet, SearchDocumentResultCursor> {
  const folderIds = normalizeFolderIds(args.folderIds ?? []);
  const descriptor = createMediaResultSourceDescriptor({
    extensionName: args.extensionName,
    folderIds,
    direction: 'desc',
  });
  const cache = new LruPageCache<Tweet, SearchDocumentResultCursor>(
    args.cachePages ?? DEFAULT_CACHE_PAGE_LIMIT,
  );
  const key = serializeResultSourceDescriptor(descriptor);
  let totalCountPromise: Promise<number> | null = null;

  const totalCount = async () => {
    if (!totalCountPromise) {
      totalCountPromise = db
        .extGetSearchDocumentMediaCount(args.extensionName, {
          entityType: 'tweet',
          folderIds,
        })
        .then((count) => Number(count) || 0)
        .finally(() => {
          totalCountPromise = null;
        });
    }
    return await totalCountPromise;
  };

  const getWindow = async (
    request: ResultWindowRequest<SearchDocumentResultCursor>,
  ): Promise<ResultWindow<Tweet, SearchDocumentResultCursor>> => {
    const startedAt = performance.now();
    const limit = Math.max(1, Math.min(1000, Number(request.limit) || DEFAULT_PAGE_SIZE));
    const normalizedRequest: ResultWindowRequest<SearchDocumentResultCursor> = {
      ...request,
      limit,
      direction: request.direction ?? 'forward',
    };
    const cacheKey = requestCacheKey(normalizedRequest);
    const cached = cache.get(cacheKey);
    if (cached) {
      recordResultSourceDiagnostics({
        sourceKey: key,
        descriptor,
        totalCount: cached.totalCount,
        cachedPages: cache.size,
        cachedRows: cache.rowCount,
        lastFetchDurationMs: performance.now() - startedAt,
        lastWindowRows: cached.rows.length,
        lastWindowStartIndex: cached.startIndex,
        lastCacheHit: true,
      });
      return cached;
    }

    const offset = Math.max(0, Math.floor(Number(normalizedRequest.startIndex) || 0));
    const [count, page] = await Promise.all([
      totalCount(),
      db.extGetSearchDocumentMediaCursorPage(args.extensionName, {
        entityType: 'tweet',
        folderIds,
        after: normalizedRequest.after,
        before: normalizedRequest.before,
        offset: normalizedRequest.after || normalizedRequest.before ? undefined : offset,
        limit,
        order: 'newest',
      }),
    ]);
    const ids = page.documents.map((document) => document.entity_id).filter(Boolean);
    const rows = ((await db.extGetTweetsByIds(ids)) ?? []) as Tweet[];
    const window: ResultWindow<Tweet, SearchDocumentResultCursor> = {
      source: descriptor,
      totalCount: count,
      startIndex: normalizedRequest.startIndex,
      rows,
      rowIds: ids,
      hasBefore: page.hasBefore,
      hasAfter: page.hasAfter,
      cursorBefore: page.cursorBefore,
      cursorAfter: page.cursorAfter,
    };
    cache.set(cacheKey, window);
    recordResultSourceDiagnostics({
      sourceKey: key,
      descriptor,
      totalCount: count,
      cachedPages: cache.size,
      cachedRows: cache.rowCount,
      lastFetchDurationMs: performance.now() - startedAt,
      lastWindowRows: rows.length,
      lastWindowStartIndex: normalizedRequest.startIndex,
      lastCacheHit: false,
    });
    return window;
  };

  return {
    key,
    descriptor,
    totalCount,
    getWindow,
    getByIds: async (ids) => ((await db.extGetTweetsByIds(ids)) ?? []) as Tweet[],
    streamRows: async function* streamRows(streamArgs = {}) {
      let cursor = streamArgs.cursor;
      let startIndex = 0;
      const cursorPaging = Boolean(streamArgs.cursor);
      const batchSize = Math.max(
        1,
        Math.min(1000, Number(streamArgs.batchSize) || DEFAULT_PAGE_SIZE),
      );
      while (!streamArgs.signal?.aborted) {
        const page =
          cursorPaging && cursor
            ? await getWindow({ limit: batchSize, after: cursor })
            : await getWindow({ startIndex, limit: batchSize });
        for (const row of page.rows) {
          if (streamArgs.signal?.aborted) return;
          yield row;
        }
        if (!page.hasAfter || !page.rows.length) return;
        startIndex += page.rows.length;
        if (page.cursorAfter) {
          cursor = page.cursorAfter;
        } else if (cursorPaging) {
          return;
        }
      }
    },
  };
}
