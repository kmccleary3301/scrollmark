import { ExtensionType } from '@/core/extensions/extension';
import { db } from '@/core/database';
import type { SearchDocumentFolderFacetSummary, SearchDocumentRow } from '@/core/database/manager';
import type { ResultEntityType } from '@/core/database/result-source';
import type { ResultSourceDescriptor } from '@/core/database/result-source';
import { nowMs, recordPerfMetric } from '@/core/perf/metrics';
import { Tweet, User } from '@/types';
import logger from '@/utils/logger';
import { useLiveQuery } from '@/utils/observable';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useDatabaseMutationVersion } from './mutation';
import {
  createFolderResultSource,
  createLiveCapturesResultSource,
  createMediaResultSource,
} from './result-sources';
import type { ResultWindow, SearchDocumentResultCursor } from './result-source';

const VIEWER_INITIAL_PAGE_SIZE = 80;
const SOURCE_WINDOW_MIN_PAGE_SIZE = 48;
const SOURCE_WINDOW_MAX_PAGE_SIZE = 240;
const SEARCH_DOCUMENT_FULL_LOAD_LIMIT = 50000;
const SEARCH_DOCUMENT_FULL_LOAD_OVERRIDE_KEY = 'twe_allow_large_search_corpus_v1';
const SEARCH_DOCUMENT_COUNT_OVERRIDE_KEY = 'twe_search_document_full_load_count_override_v1';
const SOURCE_WINDOW_REQUEST_DELAY_KEY = 'twe_source_window_request_delay_ms_v1';
const MAX_DIAGNOSTIC_SOURCE_WINDOW_DELAY_MS = 5000;
const MEDIA_COUNT_BACKGROUND_DELAY_MS = 12000;

export type DbBackedCapturedRecordsState<T> = {
  sourceKey: string;
  sourceDescriptor: ResultSourceDescriptor;
  records: T[];
  loading: boolean;
  loadingWindow: boolean;
  loadedCount: number;
  totalCount: number;
  hasMore: boolean;
  windowStartIndex: number;
  requestWindow: (startIndex: number, endIndex: number) => void;
  reload: () => Promise<void>;
  streamRows: () => AsyncIterable<T>;
};

export type DbBackedFolderRecordsState<T> = DbBackedCapturedRecordsState<T> & {
  active: boolean;
  folderId: string;
};

export type DbBackedMediaRecordsState<T> = {
  sourceKey: string;
  sourceDescriptor: ResultSourceDescriptor;
  totalCount: number;
  getWindow: (
    startIndex: number,
    limit: number,
  ) => Promise<ResultWindow<T, SearchDocumentResultCursor>>;
  streamRows: () => AsyncIterable<T>;
};

type SearchDocumentsState = {
  documents: SearchDocumentRow[];
  loading: boolean;
  loaded: boolean;
  totalCount: number;
  blockedReason?: string;
  load: () => Promise<SearchDocumentRow[]>;
  loadChunks: (args: {
    chunkSize?: number;
    isCancelled?: () => boolean;
    onChunk: (
      documents: SearchDocumentRow[],
      progress: { loaded: number; totalCount: number },
    ) => void;
  }) => Promise<{ loaded: number; totalCount: number; cancelled: boolean }>;
};

type SearchDocumentFolderFacetsState = {
  summary: SearchDocumentFolderFacetSummary | null;
  loading: boolean;
};

type PendingSourceWindowRequest = {
  startIndex: number;
  endIndex: number;
};

function isLargeSearchCorpusOverrideEnabled(): boolean {
  try {
    return localStorage.getItem(SEARCH_DOCUMENT_FULL_LOAD_OVERRIDE_KEY) === '1';
  } catch {
    return false;
  }
}

function readSearchDocumentCountOverride(): number | null {
  try {
    const rawValue = localStorage.getItem(SEARCH_DOCUMENT_COUNT_OVERRIDE_KEY);
    if (!rawValue) return null;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
  } catch {
    return null;
  }
}

function readDiagnosticSourceWindowDelayMs(): number {
  try {
    const rawValue = localStorage.getItem(SOURCE_WINDOW_REQUEST_DELAY_KEY);
    if (!rawValue) return 0;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(MAX_DIAGNOSTIC_SOURCE_WINDOW_DELAY_MS, Math.floor(value));
  } catch {
    return 0;
  }
}

async function waitDiagnosticSourceWindowDelay(): Promise<void> {
  const delayMs = readDiagnosticSourceWindowDelayMs();
  if (delayMs <= 0) return;
  await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

export function createSearchDocumentFullLoadBlockedReason(totalDocuments: number): string | null {
  if (totalDocuments <= SEARCH_DOCUMENT_FULL_LOAD_LIMIT || isLargeSearchCorpusOverrideEnabled()) {
    return null;
  }
  return `Search corpus has ${totalDocuments.toLocaleString()} indexed documents. Full in-memory search is blocked above ${SEARCH_DOCUMENT_FULL_LOAD_LIMIT.toLocaleString()} documents; normal high-count search should use chunked DB-to-worker preparation instead. Set localStorage.${SEARCH_DOCUMENT_FULL_LOAD_OVERRIDE_KEY} = "1" to force the legacy path for local diagnostics.`;
}

function entityTypeFromExtensionType(type: ExtensionType): ResultEntityType {
  return type === ExtensionType.USER ? 'user' : 'tweet';
}

export function useDbBackedCapturedRecords(
  extName: string,
  type: ExtensionType,
): DbBackedCapturedRecordsState<Tweet | User> {
  const mutationVersion = useDatabaseMutationVersion(extName);
  const source = useMemo(
    () => createLiveCapturesResultSource({ extensionName: extName, extensionType: type }),
    [extName, mutationVersion, type],
  );
  const requestKeyRef = useRef('');
  const inFlightWindowRef = useRef(false);
  const queuedWindowRef = useRef<PendingSourceWindowRequest | null>(null);
  const [state, setState] = useState({
    records: [] as Array<Tweet | User>,
    loading: true,
    loadingWindow: false,
    loadedCount: 0,
    totalCount: 0,
    hasMore: false,
    windowStartIndex: 0,
  });

  const loadWindow = useCallback(
    async (startIndex: number, endIndex: number, initial = false) => {
      const normalizedStart = Math.max(0, Math.floor(Number(startIndex) || 0));
      const normalizedEnd = Math.max(normalizedStart + 1, Math.floor(Number(endIndex) || 0));
      const limit = Math.min(
        SOURCE_WINDOW_MAX_PAGE_SIZE,
        Math.max(SOURCE_WINDOW_MIN_PAGE_SIZE, normalizedEnd - normalizedStart),
      );
      const requestKey = `${mutationVersion}:${normalizedStart}:${limit}`;
      if (requestKeyRef.current === requestKey) return;
      requestKeyRef.current = requestKey;
      if (inFlightWindowRef.current && !initial) {
        queuedWindowRef.current = { startIndex: normalizedStart, endIndex: normalizedEnd };
        recordPerfMetric({
          kind: 'viewer',
          name: 'source-window-request-coalesced',
          value: limit,
          tags: {
            mode: 'captures',
            extName,
            type,
            startIndex: normalizedStart,
            limit,
          },
        });
        return;
      }
      inFlightWindowRef.current = true;
      const startedAt = nowMs();
      setState((current) => ({
        ...current,
        loading: initial ? true : current.loading,
        loadingWindow: !initial,
      }));
      try {
        await waitDiagnosticSourceWindowDelay();
        const window = await source.getWindow({ startIndex: normalizedStart, limit });
        if (requestKeyRef.current !== requestKey) {
          recordPerfMetric({
            kind: 'viewer',
            name: 'source-window-stale-ignored',
            durationMs: nowMs() - startedAt,
            value: window.rows.length,
            tags: {
              mode: 'captures',
              extName,
              type,
              startIndex: normalizedStart,
              limit,
              totalCount: window.totalCount,
              initial,
            },
          });
          return;
        }
        setState({
          records: window.rows,
          loading: false,
          loadingWindow: false,
          loadedCount: window.rows.length,
          totalCount: window.totalCount,
          hasMore: window.hasAfter,
          windowStartIndex: normalizedStart,
        });
        recordPerfMetric({
          kind: 'viewer',
          name: 'db-backed-capture-window',
          durationMs: nowMs() - startedAt,
          value: window.rows.length,
          tags: {
            extName,
            type,
            startIndex: normalizedStart,
            limit,
            totalCount: window.totalCount,
            initial,
          },
        });
      } finally {
        inFlightWindowRef.current = false;
        const queued = queuedWindowRef.current;
        queuedWindowRef.current = null;
        if (queued) {
          requestKeyRef.current = '';
          void loadWindow(queued.startIndex, queued.endIndex, false).catch((error) => {
            logger.warn('DB-backed queued capture window load failed', error);
            setState((current) => ({ ...current, loading: false, loadingWindow: false }));
          });
        }
      }
    },
    [extName, mutationVersion, source, type],
  );

  const reload = useCallback(async () => {
    requestKeyRef.current = '';
    await loadWindow(0, VIEWER_INITIAL_PAGE_SIZE, true);
  }, [loadWindow]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const requestWindow = useCallback(
    (startIndex: number, endIndex: number) => {
      void loadWindow(startIndex, endIndex, false).catch((error) => {
        logger.warn('DB-backed capture window load failed', error);
        setState((current) => ({ ...current, loading: false, loadingWindow: false }));
      });
    },
    [loadWindow],
  );

  return {
    sourceKey: source.key,
    sourceDescriptor: source.descriptor,
    ...state,
    requestWindow,
    reload,
    streamRows: () => source.streamRows(),
  };
}

export function useDbBackedFolderRecords(
  extName: string,
  type: ExtensionType,
  folderIds: string | string[] | undefined,
  enabled: boolean,
  knownTotalCount?: number,
): DbBackedFolderRecordsState<Tweet | User> {
  const mutationVersion = useDatabaseMutationVersion(extName);
  const normalizedFolderIds = useMemo(
    () =>
      [
        ...new Set(
          (Array.isArray(folderIds) ? folderIds : folderIds ? [folderIds] : [])
            .map((folderId) => folderId.trim())
            .filter(Boolean),
        ),
      ].sort(),
    [folderIds],
  );
  const normalizedFolderKey = normalizedFolderIds.join(',');
  const source = useMemo(() => {
    if (!enabled || !normalizedFolderIds.length) return null;
    return createFolderResultSource({
      extensionName: extName,
      entityType: entityTypeFromExtensionType(type),
      folderIds: normalizedFolderIds,
      knownTotalCount,
    });
  }, [enabled, extName, knownTotalCount, mutationVersion, normalizedFolderIds, type]);
  const requestKeyRef = useRef('');
  const inFlightWindowRef = useRef(false);
  const queuedWindowRef = useRef<PendingSourceWindowRequest | null>(null);
  const [state, setState] = useState({
    records: [] as Array<Tweet | User>,
    loading: false,
    loadingWindow: false,
    loadedCount: 0,
    totalCount: 0,
    hasMore: false,
    windowStartIndex: 0,
  });

  const loadWindow = useCallback(
    async (startIndex: number, endIndex: number, initial = false) => {
      if (!source || !enabled || !normalizedFolderIds.length) return;
      const normalizedStart = Math.max(0, Math.floor(Number(startIndex) || 0));
      const normalizedEnd = Math.max(normalizedStart + 1, Math.floor(Number(endIndex) || 0));
      const limit = Math.min(
        SOURCE_WINDOW_MAX_PAGE_SIZE,
        Math.max(SOURCE_WINDOW_MIN_PAGE_SIZE, normalizedEnd - normalizedStart),
      );
      const requestKey = `${mutationVersion}:${normalizedFolderKey}:${normalizedStart}:${limit}`;
      if (requestKeyRef.current === requestKey) return;
      requestKeyRef.current = requestKey;
      if (inFlightWindowRef.current && !initial) {
        queuedWindowRef.current = { startIndex: normalizedStart, endIndex: normalizedEnd };
        recordPerfMetric({
          kind: 'viewer',
          name: 'source-window-request-coalesced',
          value: limit,
          tags: {
            mode: 'folder',
            extName,
            type,
            folderId: normalizedFolderKey,
            folderCount: normalizedFolderIds.length,
            startIndex: normalizedStart,
            limit,
          },
        });
        return;
      }
      inFlightWindowRef.current = true;
      const startedAt = nowMs();
      setState((current) => ({
        ...current,
        loading: initial ? true : current.loading,
        loadingWindow: !initial,
      }));
      try {
        await waitDiagnosticSourceWindowDelay();
        const window = await source.getWindow({ startIndex: normalizedStart, limit });
        if (requestKeyRef.current !== requestKey) {
          recordPerfMetric({
            kind: 'viewer',
            name: 'source-window-stale-ignored',
            durationMs: nowMs() - startedAt,
            value: window.rows.length,
            tags: {
              mode: 'folder',
              extName,
              type,
              folderId: normalizedFolderKey,
              folderCount: normalizedFolderIds.length,
              startIndex: normalizedStart,
              limit,
              totalCount: window.totalCount,
              initial,
            },
          });
          return;
        }
        setState({
          records: window.rows,
          loading: false,
          loadingWindow: false,
          loadedCount: window.rows.length,
          totalCount: window.totalCount,
          hasMore: window.hasAfter,
          windowStartIndex: normalizedStart,
        });
        recordPerfMetric({
          kind: 'viewer',
          name: 'db-backed-folder-window',
          durationMs: nowMs() - startedAt,
          value: window.rows.length,
          tags: {
            extName,
            type,
            folderId: normalizedFolderKey,
            folderCount: normalizedFolderIds.length,
            startIndex: normalizedStart,
            limit,
            totalCount: window.totalCount,
            initial,
          },
        });
      } finally {
        inFlightWindowRef.current = false;
        const queued = queuedWindowRef.current;
        queuedWindowRef.current = null;
        if (queued) {
          requestKeyRef.current = '';
          void loadWindow(queued.startIndex, queued.endIndex, false).catch((error) => {
            logger.warn('DB-backed queued folder window load failed', error);
            setState((current) => ({ ...current, loading: false, loadingWindow: false }));
          });
        }
      }
    },
    [
      enabled,
      extName,
      mutationVersion,
      normalizedFolderIds.length,
      normalizedFolderKey,
      source,
      type,
    ],
  );

  const reload = useCallback(async () => {
    requestKeyRef.current = '';
    if (!source || !enabled || !normalizedFolderIds.length) {
      setState({
        records: [],
        loading: false,
        loadingWindow: false,
        loadedCount: 0,
        totalCount: 0,
        hasMore: false,
        windowStartIndex: 0,
      });
      return;
    }
    await loadWindow(0, VIEWER_INITIAL_PAGE_SIZE, true);
  }, [enabled, loadWindow, normalizedFolderIds.length, source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const requestWindow = useCallback(
    (startIndex: number, endIndex: number) => {
      if (!source || !enabled || !normalizedFolderIds.length) return;
      void loadWindow(startIndex, endIndex, false).catch((error) => {
        logger.warn('DB-backed folder window load failed', error);
        setState((current) => ({ ...current, loading: false, loadingWindow: false }));
      });
    },
    [enabled, loadWindow, normalizedFolderIds.length, source],
  );

  return {
    sourceKey: source?.key ?? '',
    sourceDescriptor:
      source?.descriptor ??
      createFolderResultSource({
        extensionName: extName,
        entityType: entityTypeFromExtensionType(type),
        folderIds: normalizedFolderIds.length ? normalizedFolderIds : ['__inactive__'],
      }).descriptor,
    ...state,
    active: Boolean(source && enabled && normalizedFolderIds.length),
    folderId: normalizedFolderKey,
    requestWindow,
    reload,
    streamRows: () => source?.streamRows() ?? emptyAsyncStream<Tweet | User>(),
  };
}

export function useDbBackedMediaRecords(
  extName: string,
  folderIds: string[] | undefined,
  enabled: boolean,
): DbBackedMediaRecordsState<Tweet> | null {
  const mutationVersion = useDatabaseMutationVersion(extName);
  const normalizedFolderIds = useMemo(
    () => [...new Set((folderIds ?? []).map((folderId) => folderId.trim()).filter(Boolean))].sort(),
    [folderIds],
  );
  const normalizedFolderKey = normalizedFolderIds.join(',');
  const source = useMemo(() => {
    if (!enabled) return null;
    return createMediaResultSource({
      extensionName: extName,
      folderIds: normalizedFolderIds,
    });
  }, [enabled, extName, mutationVersion, normalizedFolderIds]);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null = null;
    if (!source) {
      setTotalCount(0);
      return;
    }
    timeoutHandle = globalThis.setTimeout(() => {
      void source.totalCount().then((count) => {
        if (!cancelled) {
          setTotalCount(count);
        }
      });
    }, MEDIA_COUNT_BACKGROUND_DELAY_MS);
    return () => {
      cancelled = true;
      if (timeoutHandle !== null) {
        globalThis.clearTimeout(timeoutHandle);
      }
    };
  }, [normalizedFolderKey, source]);

  if (!source) return null;
  return {
    sourceKey: source.key,
    sourceDescriptor: source.descriptor,
    totalCount,
    getWindow: async (startIndex: number, limit: number) => {
      const window = await source.getWindow({ startIndex, limit });
      setTotalCount((current) => Math.max(current, window.totalCount));
      return window;
    },
    streamRows: () => source.streamRows(),
  };
}

async function* emptyAsyncStream<T>(): AsyncIterable<T> {}

export function useCaptureCount(extName: string) {
  const mutationVersion = useDatabaseMutationVersion(extName);
  const count = useLiveQuery(
    async () => {
      await db.whenReady();
      return Math.max(0, Math.floor(Number((await db.extGetCaptureCount(extName)) || 0)));
    },
    [extName, mutationVersion],
    0,
  );

  return Math.max(0, Math.floor(Number(count) || 0));
}

export function useSearchDocuments(
  extName: string,
  type: ExtensionType,
  enabled = true,
): SearchDocumentsState {
  const mutationVersion = useDatabaseMutationVersion(extName);
  const [state, setState] = useState<Omit<SearchDocumentsState, 'load' | 'loadChunks'>>({
    documents: [],
    loading: enabled,
    loaded: false,
    totalCount: 0,
  });
  const backfillKeyRef = useRef('');
  const inFlightRef = useRef<Promise<SearchDocumentRow[]> | null>(null);
  const activeLoadKeyRef = useRef('');
  const loadSequenceRef = useRef(0);

  const load = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    const loadKey = `${mutationVersion}:${extName}:${type}:${loadSequenceRef.current + 1}`;
    loadSequenceRef.current += 1;
    activeLoadKeyRef.current = loadKey;
    setState((current) => ({ ...current, loading: true }));
    const promise = db
      .extGetSearchDocumentCount(extName, { type })
      .then(async (documentCount) => {
        if (activeLoadKeyRef.current !== loadKey) return [];
        const actualDocumentCount = Number(documentCount) || 0;
        const totalDocuments = readSearchDocumentCountOverride() ?? actualDocumentCount;
        const blockedReason = createSearchDocumentFullLoadBlockedReason(totalDocuments);
        if (blockedReason) {
          if (activeLoadKeyRef.current === loadKey) {
            setState({
              documents: [],
              loading: false,
              loaded: true,
              totalCount: totalDocuments,
            });
          }
          recordPerfMetric({
            kind: 'search',
            name: 'large-corpus-chunked-load-required',
            value: totalDocuments,
            tags: {
              extName,
              type,
              limit: SEARCH_DOCUMENT_FULL_LOAD_LIMIT,
            },
          });
          return [];
        }

        const [documents, captureCount] = await Promise.all([
          db.extGetSearchDocuments(extName, type),
          db.extGetCaptureCount(extName, type),
        ]);
        if (activeLoadKeyRef.current !== loadKey) return [];
        const rows = documents ?? [];
        setState({
          documents: rows,
          loading: false,
          loaded: true,
          totalCount: totalDocuments || rows.length,
        });

        const total = captureCount ?? 0;
        const backfillKey = `${extName}:${type}:${total}:${rows.length}`;
        const toleratedGap = Math.max(50, Math.ceil(total * 0.02));
        if (
          total > 0 &&
          rows.length + toleratedGap < total &&
          backfillKeyRef.current !== backfillKey
        ) {
          backfillKeyRef.current = backfillKey;
          void db.extBackfillSearchDocuments(extName, type).catch((error) => {
            logger.warn('Search document backfill failed', error);
          });
        }
        return rows;
      })
      .catch((error) => {
        if (activeLoadKeyRef.current !== loadKey) return [];
        logger.warn('Search documents load failed', error);
        setState({ documents: [], loading: false, loaded: true, totalCount: 0 });
        return [];
      })
      .finally(() => {
        if (activeLoadKeyRef.current === loadKey) {
          inFlightRef.current = null;
        }
      });
    inFlightRef.current = promise;
    return promise;
  }, [extName, mutationVersion, type]);

  const loadChunks = useCallback(
    async (args: {
      chunkSize?: number;
      isCancelled?: () => boolean;
      onChunk: (
        documents: SearchDocumentRow[],
        progress: { loaded: number; totalCount: number },
      ) => void;
    }) => {
      const startedAt = nowMs();
      const chunkSize = Math.max(100, Math.min(5000, Math.floor(args.chunkSize || 1000)));
      const actualDocumentCount =
        Number(await db.extGetSearchDocumentCount(extName, { type })) || 0;
      const totalCount = readSearchDocumentCountOverride() ?? actualDocumentCount;
      let loaded = 0;
      let offset = 0;
      let cancelled = false;

      try {
        while (offset < actualDocumentCount) {
          if (args.isCancelled?.()) {
            cancelled = true;
            break;
          }
          const page = await db.extGetSearchDocumentPage(extName, {
            type,
            offset,
            limit: chunkSize,
          });
          if (args.isCancelled?.()) {
            cancelled = true;
            break;
          }
          const documents = page.documents ?? [];
          if (!documents.length) break;
          loaded += documents.length;
          args.onChunk(documents, { loaded, totalCount });
          recordPerfMetric({
            kind: 'search',
            name: 'search-document-chunk-loaded',
            value: loaded,
            tags: {
              extName,
              type,
              chunkSize,
              chunkRows: documents.length,
              totalCount,
              offset,
            },
          });
          offset += documents.length;
          if (!page.hasAfter) break;
          await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        }
      } finally {
        setState((current) => ({
          ...current,
          documents:
            totalCount > SEARCH_DOCUMENT_FULL_LOAD_LIMIT && !isLargeSearchCorpusOverrideEnabled()
              ? []
              : current.documents,
          loading: false,
          loaded: current.loaded || !cancelled,
          totalCount,
          blockedReason: undefined,
        }));
      }

      recordPerfMetric({
        kind: 'search',
        name: cancelled
          ? 'search-document-chunk-load-cancelled'
          : 'search-document-chunk-load-complete',
        durationMs: nowMs() - startedAt,
        value: loaded,
        tags: { extName, type, chunkSize, totalCount },
      });
      return { loaded, totalCount, cancelled };
    },
    [extName, type],
  );

  useEffect(() => {
    let cancelled = false;
    inFlightRef.current = null;
    activeLoadKeyRef.current = '';
    setState({ documents: [], loading: enabled, loaded: false, totalCount: 0 });
    if (enabled) {
      void load().then(() => {
        if (cancelled) return;
      });
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, extName, load, mutationVersion, type]);

  return { ...state, load, loadChunks };
}

export function useSearchDocumentFolderFacets(
  extName: string,
  type: ExtensionType,
  enabled = true,
): SearchDocumentFolderFacetsState {
  const mutationVersion = useDatabaseMutationVersion(extName);
  const [state, setState] = useState<SearchDocumentFolderFacetsState>({
    summary: null,
    loading: enabled,
  });

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState({ summary: null, loading: false });
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    void db
      .extGetSearchDocumentFolderFacets(extName, { type })
      .then((summary) => {
        if (cancelled) return;
        setState({ summary, loading: false });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.warn('Search document folder facets failed', error);
        setState({ summary: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, extName, mutationVersion, type]);

  return state;
}

export function useClearCaptures(extName: string) {
  return async () => {
    logger.debug('Clearing captures for extension:', extName);
    return db.extClearCaptures(extName);
  };
}
