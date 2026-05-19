import { ExtensionType } from '@/core/extensions';
import { db } from '@/core/database';
import type { SearchDocumentRow } from '@/core/database/manager';
import { nowMs, recordPerfMetric } from '@/core/perf/metrics';
import { Tweet, User } from '@/types';
import logger from '@/utils/logger';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { unsafeWindow } from '$';
import { useDatabaseMutationVersion } from './mutation';

const CAPTURE_COUNT_SNAPSHOT_KEY = '__twe_capture_counts_v1';
const CAPTURE_COUNT_SNAPSHOT_V2_KEY = '__twe_capture_counts_v2';
const ACTIVE_DB_NAME_KEY = '__twe_active_db_name_v1';
const DB_MUTATION_STORAGE_KEY = '__twe_db_mutation_v1';
const CAPTURE_COUNT_EVENT_NAME = 'twe:capture-count-updated-v1';
const CAPTURED_RECORDS_CACHE_LIMIT = 10;
const VIEWER_INITIAL_PAGE_SIZE = 160;
const VIEWER_NEXT_PAGE_SIZE = 320;
const VIEWER_WARM_PREFETCH_TARGET = 960;

type SnapshotCandidate = {
  count: number;
  dbName: string;
  updatedAt: number;
};

type CapturedRecordsState<T> = {
  records: T[];
  loading: boolean;
  loadingMore: boolean;
  loadedCount: number;
  totalCount: number;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  loadAll: () => Promise<void>;
};

type CapturedRecordsDataState<T> = Omit<CapturedRecordsState<T>, 'loadMore' | 'loadAll'>;

type SearchDocumentsState = {
  documents: SearchDocumentRow[];
  loading: boolean;
};

type CapturedRecordsCacheEntry = {
  mutationVersion: number;
  totalCount: number;
  nextOffset: number;
  exhausted: boolean;
  records: Array<Tweet | User>;
};

const capturedRecordsCache = new Map<string, CapturedRecordsCacheEntry>();

function setCapturedRecordsCacheEntry(key: string, value: CapturedRecordsCacheEntry) {
  if (capturedRecordsCache.has(key)) {
    capturedRecordsCache.delete(key);
  }
  capturedRecordsCache.set(key, value);
  while (capturedRecordsCache.size > CAPTURED_RECORDS_CACHE_LIMIT) {
    const oldestKey = capturedRecordsCache.keys().next().value;
    if (!oldestKey) break;
    capturedRecordsCache.delete(oldestKey);
  }
}

async function readCaptureCountFromDb(dbName: string, extName: string): Promise<number> {
  return await new Promise((resolve) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => resolve(0);
    openReq.onsuccess = () => {
      const opened = openReq.result;
      let tx: IDBTransaction;
      try {
        if (!opened.objectStoreNames.contains('captures')) {
          opened.close();
          resolve(0);
          return;
        }
        tx = opened.transaction(['captures'], 'readonly');
      } catch {
        opened.close();
        resolve(0);
        return;
      }

      let req: IDBRequest<number>;
      try {
        const store = tx.objectStore('captures');
        if (store.indexNames.contains('extension')) {
          req = store.index('extension').count(extName);
        } else {
          req = store.count();
        }
      } catch {
        opened.close();
        resolve(0);
        return;
      }

      req.onsuccess = () => {
        opened.close();
        resolve(Number(req.result) || 0);
      };
      req.onerror = () => {
        opened.close();
        resolve(0);
      };
    };
  });
}

async function getCaptureCountAcrossKnownDatabases(extName: string): Promise<number> {
  const getActiveDatabaseName = (): string | null => {
    try {
      const unsafeCandidate = unsafeWindow as unknown as Record<string, unknown>;
      const unsafeName = unsafeCandidate?.[ACTIVE_DB_NAME_KEY];
      if (typeof unsafeName === 'string' && unsafeName.trim().length > 0) {
        return unsafeName.trim();
      }
    } catch {
      // ignore
    }

    try {
      const directName = (globalThis as Record<string, unknown>)[ACTIVE_DB_NAME_KEY];
      if (typeof directName === 'string' && directName.trim().length > 0) {
        return directName.trim();
      }
    } catch {
      // ignore
    }

    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem(ACTIVE_DB_NAME_KEY);
        if (stored && stored.trim().length > 0) {
          return stored.trim();
        }
      }
    } catch {
      // ignore
    }

    return null;
  };

  const readSnapshot = (activeDbName: string | null): number => {
    const candidates: SnapshotCandidate[] = [];

    const collectFromV2Entry = (entry: unknown): void => {
      if (!entry || typeof entry !== 'object') return;
      const obj = entry as Record<string, unknown>;
      const count = Number(obj.count);
      if (!Number.isFinite(count)) return;
      const dbName = typeof obj.dbName === 'string' ? obj.dbName : '';
      const updatedAt = Number(obj.updatedAt);
      candidates.push({
        count,
        dbName,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      });
    };

    const collectFromV1Entry = (entry: unknown): void => {
      const count = Number(entry);
      if (!Number.isFinite(count)) return;
      candidates.push({ count, dbName: '', updatedAt: 0 });
    };

    const collectFromSource = (source: unknown): void => {
      if (!source || typeof source !== 'object') return;
      const root = source as Record<string, unknown>;
      const v2 = root[CAPTURE_COUNT_SNAPSHOT_V2_KEY];
      if (v2 && typeof v2 === 'object') {
        collectFromV2Entry((v2 as Record<string, unknown>)[extName]);
      }
      const v1 = root[CAPTURE_COUNT_SNAPSHOT_KEY];
      if (v1 && typeof v1 === 'object') {
        collectFromV1Entry((v1 as Record<string, unknown>)[extName]);
      }
    };

    try {
      collectFromSource(unsafeWindow as unknown as Record<string, unknown>);
    } catch {
      // ignore
    }

    try {
      collectFromSource(globalThis as Record<string, unknown>);
    } catch {
      // ignore
    }

    try {
      if (typeof localStorage !== 'undefined') {
        const rawV2 = localStorage.getItem(CAPTURE_COUNT_SNAPSHOT_V2_KEY);
        if (rawV2) {
          const parsed = JSON.parse(rawV2) as Record<string, unknown>;
          collectFromV2Entry(parsed?.[extName]);
        }
        const rawV1 = localStorage.getItem(CAPTURE_COUNT_SNAPSHOT_KEY);
        if (rawV1) {
          const parsed = JSON.parse(rawV1) as Record<string, unknown>;
          collectFromV1Entry(parsed?.[extName]);
        }
      }
    } catch {
      // ignore
    }

    if (!candidates.length) {
      return 0;
    }

    if (activeDbName) {
      const scoped = candidates
        .filter((candidate) => candidate.dbName === activeDbName)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const firstScoped = scoped[0];
      if (firstScoped) {
        return firstScoped.count;
      }
    }

    candidates.sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return b.count - a.count;
    });
    const first = candidates[0];
    return first ? first.count : 0;
  };

  const activeDbName = getActiveDatabaseName();

  if (typeof indexedDB === 'undefined') {
    return Math.max(
      readSnapshot(activeDbName),
      Number((await db.extGetCaptureCount(extName)) || 0),
    );
  }

  let names: string[] = [];
  try {
    const rows = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    names = Array.from(
      new Set(
        (rows || [])
          .map((row) => row?.name)
          .filter(
            (name): name is string =>
              !!name && (name.includes('twitter-web-exporter') || name.includes('scrollmark')),
          ),
      ),
    );
  } catch {
    names = [];
  }

  if (!names.length) {
    if (activeDbName) {
      const activeDbCount = await readCaptureCountFromDb(activeDbName, extName);
      return Math.max(
        activeDbCount,
        readSnapshot(activeDbName),
        Number((await db.extGetCaptureCount(extName)) || 0),
      );
    }
    return Math.max(
      readSnapshot(activeDbName),
      Number((await db.extGetCaptureCount(extName)) || 0),
    );
  }

  if (activeDbName && names.includes(activeDbName)) {
    const activeDbCount = await readCaptureCountFromDb(activeDbName, extName);
    return Math.max(
      activeDbCount,
      readSnapshot(activeDbName),
      Number((await db.extGetCaptureCount(extName)) || 0),
    );
  }

  let best = 0;
  for (const name of names) {
    const count = await readCaptureCountFromDb(name, extName);
    if (count > best) {
      best = count;
    }
  }

  return Math.max(
    best,
    readSnapshot(activeDbName),
    Number((await db.extGetCaptureCount(extName)) || 0),
  );
}

export function useCaptureCount(extName: string) {
  const mutationVersion = useDatabaseMutationVersion(extName);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let disposed = false;
    let refreshInFlight = false;
    let refreshQueued = false;

    const refresh = async () => {
      try {
        const next = await getCaptureCountAcrossKnownDatabases(extName);
        if (!disposed) {
          setCount(next);
        }
      } catch {
        // ignore polling failures
      }
    };

    const scheduleRefresh = () => {
      if (disposed) {
        return;
      }
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      void (async () => {
        try {
          await refresh();
        } finally {
          refreshInFlight = false;
          if (refreshQueued) {
            refreshQueued = false;
            scheduleRefresh();
          }
        }
      })();
    };

    const onStorage = (event: StorageEvent) => {
      const key = event.key;
      if (!key) return;
      if (
        key !== CAPTURE_COUNT_SNAPSHOT_KEY &&
        key !== CAPTURE_COUNT_SNAPSHOT_V2_KEY &&
        key !== ACTIVE_DB_NAME_KEY &&
        key !== DB_MUTATION_STORAGE_KEY
      ) {
        return;
      }
      scheduleRefresh();
    };

    const onCaptureCountEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ extension?: string }>).detail;
      const targetExtension = detail && typeof detail === 'object' ? detail.extension : undefined;
      if (targetExtension && targetExtension !== extName) {
        return;
      }
      scheduleRefresh();
    };

    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const scheduleNext = () => {
      if (disposed) return;
      const delay = typeof document !== 'undefined' && document.hidden ? 6000 : 1500;
      timer = globalThis.setTimeout(() => {
        scheduleRefresh();
        scheduleNext();
      }, delay);
    };

    scheduleRefresh();
    scheduleNext();
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', onStorage);
      window.addEventListener(CAPTURE_COUNT_EVENT_NAME, onCaptureCountEvent);
    }

    return () => {
      disposed = true;
      if (timer !== null) {
        globalThis.clearTimeout(timer);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', onStorage);
        window.removeEventListener(CAPTURE_COUNT_EVENT_NAME, onCaptureCountEvent);
      }
    };
  }, [extName, mutationVersion]);

  return count;
}

export function useCapturedRecords(
  extName: string,
  type: ExtensionType,
): CapturedRecordsState<Tweet | User> {
  const mutationVersion = useDatabaseMutationVersion(extName);
  const cacheKey = `${extName}:${type}`;
  const loadingMoreRef = useRef(false);
  const nextOffsetRef = useRef(0);
  const exhaustedRef = useRef(false);
  const recordsRef = useRef<Array<Tweet | User>>([]);
  const totalCountRef = useRef(0);
  const [state, setState] = useState<CapturedRecordsDataState<Tweet | User>>(() => {
    const cached = capturedRecordsCache.get(cacheKey);
    if (cached && cached.mutationVersion === mutationVersion) {
      nextOffsetRef.current = cached.nextOffset;
      exhaustedRef.current = cached.exhausted;
      recordsRef.current = cached.records;
      totalCountRef.current = cached.totalCount;
      return {
        records: cached.records,
        loading: false,
        loadingMore: false,
        loadedCount: cached.records.length,
        totalCount: cached.totalCount,
        hasMore: !cached.exhausted,
      };
    }
    return {
      records: [],
      loading: true,
      loadingMore: false,
      loadedCount: 0,
      totalCount: 0,
      hasMore: false,
    };
  });

  const readPage = useCallback(
    async (offset: number, limit: number) => {
      const captures = await db.extGetCapturePage(extName, {
        type,
        offset,
        limit,
        order: 'newest',
      });
      const records =
        type === ExtensionType.USER
          ? ((await db.extGetCapturedUsers(extName, captures)) ?? [])
          : ((await db.extGetCapturedTweets(extName, captures)) ?? []);
      return {
        captures,
        records,
      };
    },
    [extName, type],
  );

  const commitState = useCallback(
    (next: CapturedRecordsDataState<Tweet | User>, nextOffset = next.loadedCount) => {
      recordsRef.current = next.records;
      totalCountRef.current = next.totalCount;
      nextOffsetRef.current = nextOffset;
      exhaustedRef.current = !next.hasMore;
      setState(next);
      setCapturedRecordsCacheEntry(cacheKey, {
        mutationVersion,
        totalCount: next.totalCount,
        nextOffset,
        exhausted: !next.hasMore,
        records: next.records,
      });
    },
    [cacheKey, mutationVersion],
  );

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || exhaustedRef.current) {
      return;
    }
    loadingMoreRef.current = true;
    const startedAt = nowMs();
    const offset = nextOffsetRef.current;
    setState((current) => ({ ...current, loadingMore: true }));
    try {
      const { captures, records: pageRecords } = await readPage(offset, VIEWER_NEXT_PAGE_SIZE);
      const existing = recordsRef.current;
      const existingIds = new Set(
        existing.map((record, index) =>
          String((record as unknown as Record<string, unknown>).rest_id || index),
        ),
      );
      const appended = pageRecords.filter((record, index) => {
        const id = String(
          (record as unknown as Record<string, unknown>).rest_id || `${offset}-${index}`,
        );
        if (existingIds.has(id)) return false;
        existingIds.add(id);
        return true;
      });
      const nextRecords = [...existing, ...appended];
      const hasMore =
        captures.length >= VIEWER_NEXT_PAGE_SIZE &&
        nextRecords.length < Math.max(totalCountRef.current, nextRecords.length);
      commitState(
        {
          records: nextRecords,
          loading: false,
          loadingMore: false,
          loadedCount: nextRecords.length,
          totalCount: Math.max(totalCountRef.current, nextRecords.length),
          hasMore,
        },
        offset + captures.length,
      );
      recordPerfMetric({
        kind: 'viewer',
        name: 'load-more',
        durationMs: nowMs() - startedAt,
        value: appended.length,
        tags: { extName, type, offset, loadedCount: nextRecords.length },
      });
    } finally {
      loadingMoreRef.current = false;
      setState((current) => ({ ...current, loadingMore: false }));
    }
  }, [commitState, extName, readPage, type]);

  const loadAll = useCallback(async () => {
    while (!exhaustedRef.current) {
      const beforeOffset = nextOffsetRef.current;
      await loadMore();
      if (nextOffsetRef.current === beforeOffset) {
        break;
      }
    }
  }, [loadMore]);

  useEffect(() => {
    let cancelled = false;

    const cached = capturedRecordsCache.get(cacheKey);
    if (cached && cached.mutationVersion === mutationVersion) {
      nextOffsetRef.current = cached.nextOffset;
      exhaustedRef.current = cached.exhausted;
      recordsRef.current = cached.records;
      totalCountRef.current = cached.totalCount;
      setState({
        records: cached.records,
        loading: false,
        loadingMore: false,
        loadedCount: cached.records.length,
        totalCount: cached.totalCount,
        hasMore: !cached.exhausted,
      });
      return;
    }

    const load = async () => {
      logger.debug('useCapturedRecords page load', extName);
      const startedAt = nowMs();

      const totalCount = (await db.extGetCaptureCount(extName, type)) ?? 0;
      if (cancelled) return;
      if (!totalCount) {
        commitState({
          records: [],
          loading: false,
          loadingMore: false,
          loadedCount: 0,
          totalCount: 0,
          hasMore: false,
        });
        return;
      }

      setState({
        records: [],
        loading: true,
        loadingMore: false,
        loadedCount: 0,
        totalCount,
        hasMore: false,
      });

      const { captures, records: firstRecords } = await readPage(0, VIEWER_INITIAL_PAGE_SIZE);

      if (cancelled) return;

      const hasMore =
        captures.length >= VIEWER_INITIAL_PAGE_SIZE && firstRecords.length < totalCount;
      commitState(
        {
          records: firstRecords,
          loading: false,
          loadingMore: false,
          loadedCount: firstRecords.length,
          totalCount,
          hasMore,
        },
        captures.length,
      );
      recordPerfMetric({
        kind: 'viewer',
        name: 'initial-page',
        durationMs: nowMs() - startedAt,
        value: firstRecords.length,
        tags: { extName, type, totalCount, hasMore },
      });
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, commitState, extName, mutationVersion, readPage, type]);

  useEffect(() => {
    if (state.loading || state.loadingMore || !state.hasMore) return;
    if (state.loadedCount >= VIEWER_WARM_PREFETCH_TARGET) return;

    const run = () => {
      if (loadingMoreRef.current || exhaustedRef.current) return;
      void loadMore();
    };

    if (
      typeof window !== 'undefined' &&
      'requestIdleCallback' in window &&
      typeof (window as Window & { requestIdleCallback?: unknown }).requestIdleCallback ===
        'function'
    ) {
      const handle = (
        window as Window & {
          requestIdleCallback: (
            callback: IdleRequestCallback,
            options?: IdleRequestOptions,
          ) => number;
        }
      ).requestIdleCallback(run, { timeout: 800 });
      return () => {
        if (
          typeof window !== 'undefined' &&
          'cancelIdleCallback' in window &&
          typeof (window as Window & { cancelIdleCallback?: unknown }).cancelIdleCallback ===
            'function'
        ) {
          (window as Window & { cancelIdleCallback: (handle: number) => void }).cancelIdleCallback(
            handle,
          );
        }
      };
    }

    const handle = globalThis.setTimeout(run, 120);
    return () => globalThis.clearTimeout(handle);
  }, [loadMore, state.hasMore, state.loadedCount, state.loading, state.loadingMore]);

  return {
    ...state,
    loadMore,
    loadAll,
  };
}

export function useSearchDocuments(extName: string, type: ExtensionType): SearchDocumentsState {
  const mutationVersion = useDatabaseMutationVersion(extName);
  const [state, setState] = useState<SearchDocumentsState>({ documents: [], loading: true });
  const backfillKeyRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    void Promise.all([
      db.extGetSearchDocuments(extName, type),
      db.extGetCaptureCount(extName, type),
    ])
      .then(([documents, captureCount]) => {
        if (cancelled) return;
        const rows = documents ?? [];
        setState({ documents: rows, loading: false });

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
      })
      .catch(() => {
        if (cancelled) return;
        setState({ documents: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [extName, mutationVersion, type]);

  return state;
}

export function useClearCaptures(extName: string) {
  return async () => {
    logger.debug('Clearing captures for extension:', extName);
    return db.extClearCaptures(extName);
  };
}
