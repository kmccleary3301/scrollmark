import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ColumnDef,
  functionalUpdate,
  RowSelectionState,
  SortingState,
  Updater,
} from '@tanstack/table-core';

import { AdvancedTableSearchResult, runAdvancedTableSearch } from '@/utils/advanced-table-search';
import { SearchWorkerClient } from '@/core/search/search-client';
import { incrementPerfCounter, nowMs, recordPerfMetric } from '@/core/perf/metrics';
import type { SearchDocumentRow } from '@/core/database/manager';
import type { SearchWorkerRecord } from '@/core/search/contracts';
import type { ResultEntityType, ResultSourceDescriptor } from '@/core/database/result-source';
import { createSearchResultSourceAdapter } from '@/core/database/id-result-sources';
import {
  collectRecordLookupIds,
  createResultSetSnapshot,
  extractHydrationRecordId,
  extractStableRecordId,
  ResultSetSnapshot,
  resolveOrderedAvailableRecords,
  serializeSortingState,
} from '@/utils/result-set';

import {
  compareSortValues,
  flattenLeafColumns,
  resolveColumnId,
  resolveColumnValue,
  resolveRecordRecency,
} from './table-state-helpers';

type AlternateViewDef = {
  id: string;
};

type UseResultSetControllerProps<T> = {
  title: string;
  viewStateKey?: string;
  fullscreen?: boolean;
  onFullscreenChange?: (value: boolean) => void;
  records: T[];
  searchDocuments?: SearchDocumentRow[];
  searchDocumentsLoading?: boolean;
  searchDocumentsLoaded?: boolean;
  searchDocumentTotalCount?: number;
  searchDocumentsBlockedReason?: string;
  loadSearchDocuments?: () => Promise<SearchDocumentRow[]>;
  loadSearchDocumentChunks?: (args: {
    chunkSize?: number;
    isCancelled?: () => boolean;
    onChunk: (
      documents: SearchDocumentRow[],
      progress: { loaded: number; totalCount: number },
    ) => void;
  }) => Promise<{ loaded: number; totalCount: number; cancelled: boolean }>;
  folderScopeSourceBacked?: boolean;
  resultSourceDescriptor?: ResultSourceDescriptor;
  resultSourceTotalCount?: number;
  resultEntityType?: ResultEntityType;
  hydrateRecordsByIds?: (ids: string[]) => Promise<T[]>;
  columns: ColumnDef<T>[];
  alternateViews?: AlternateViewDef[];
};

type AsyncSearchState<T> = {
  key: string;
  pending: boolean;
  phase: SearchReadinessPhase;
  result: AdvancedTableSearchResult<T> | null;
  resultIds?: string[];
  error?: string;
};

export type SearchReadinessPhase =
  | 'idle'
  | 'unavailable'
  | 'preparing-corpus'
  | 'ready'
  | 'querying'
  | 'degraded'
  | 'cancelled'
  | 'failed';

export type SearchReadinessState = {
  phase: SearchReadinessPhase;
  label: string;
  detail?: string;
  cancellable: boolean;
};

const MAX_QUERY_HYDRATE_RECORDS = 1200;
const MAX_FOLDER_HYDRATE_RECORDS = 6000;
const FOLDER_HYDRATE_BATCH_SIZE = 320;
const SEARCH_DOCUMENT_CORPUS_CHUNK_SIZE = 1000;

type FolderHydrationAttemptState = {
  key: string;
  ids: Set<string>;
};

function createEmptySearchResult<T>(
  query: string,
  warnings: string[] = [],
): AdvancedTableSearchResult<T> {
  return {
    records: [],
    highlightTerms: [],
    totalMatches: 0,
    warnings,
    warningObjects: warnings.map((message) => ({
      code: 'unsupported_token',
      message,
      severity: 'warn',
    })),
    parsed: {
      query,
      lexicalExpression: '',
      filterBooleanSemantics: 'global_and',
    },
  };
}

function createSearchResultFromRecords<T>(args: {
  query: string;
  records: T[];
  totalMatches: number;
}): AdvancedTableSearchResult<T> {
  return {
    records: args.records,
    highlightTerms: [],
    totalMatches: args.totalMatches,
    warnings: [],
    warningObjects: [],
    parsed: {
      query: args.query,
      lexicalExpression: '',
      filterBooleanSemantics: 'global_and',
    },
  };
}

function createSearchRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `search-${crypto.randomUUID()}`;
  }
  return `search-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function searchReadinessLabel(phase: SearchReadinessPhase): string {
  switch (phase) {
    case 'idle':
      return 'search idle';
    case 'unavailable':
      return 'search worker unavailable';
    case 'preparing-corpus':
      return 'preparing search index';
    case 'ready':
      return 'search ready';
    case 'querying':
      return 'querying local index';
    case 'degraded':
      return 'search degraded';
    case 'cancelled':
      return 'search cancelled';
    case 'failed':
      return 'search failed';
    default:
      return 'search';
  }
}

function readRecordPath(record: unknown, path: string): unknown {
  let current = record;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function createWorkerSearchRecord(record: unknown): unknown {
  if (!record || typeof record !== 'object') return record;
  const row = record as Record<string, unknown>;
  return {
    __typename: row.__typename,
    rest_id: row.rest_id,
    id_str: row.id_str,
    __bookmark_folder_id: row.__bookmark_folder_id,
    __bookmark_folder_name: row.__bookmark_folder_name,
    __route_type: row.__route_type,
    twe_relationship_fields: row.twe_relationship_fields,
    note_tweet: row.note_tweet,
    article: row.article,
    quoted_status_result: row.quoted_status_result,
    card: row.card,
    views: row.views,
    core: row.core,
    verification: row.verification,
    is_blue_verified: row.is_blue_verified,
    legacy: {
      id_str: readRecordPath(row, 'legacy.id_str'),
      full_text: readRecordPath(row, 'legacy.full_text'),
      text: readRecordPath(row, 'legacy.text'),
      description: readRecordPath(row, 'legacy.description'),
      created_at: readRecordPath(row, 'legacy.created_at'),
      source: readRecordPath(row, 'legacy.source'),
      lang: readRecordPath(row, 'legacy.lang'),
      entities: readRecordPath(row, 'legacy.entities'),
      extended_entities: readRecordPath(row, 'legacy.extended_entities'),
      in_reply_to_screen_name: readRecordPath(row, 'legacy.in_reply_to_screen_name'),
      in_reply_to_user_id_str: readRecordPath(row, 'legacy.in_reply_to_user_id_str'),
      in_reply_to_status_id_str: readRecordPath(row, 'legacy.in_reply_to_status_id_str'),
      conversation_id_str: readRecordPath(row, 'legacy.conversation_id_str'),
      favorite_count: readRecordPath(row, 'legacy.favorite_count'),
      retweet_count: readRecordPath(row, 'legacy.retweet_count'),
      reply_count: readRecordPath(row, 'legacy.reply_count'),
      bookmark_count: readRecordPath(row, 'legacy.bookmark_count'),
      quote_count: readRecordPath(row, 'legacy.quote_count'),
      favorited: readRecordPath(row, 'legacy.favorited'),
      retweeted: readRecordPath(row, 'legacy.retweeted'),
      bookmarked: readRecordPath(row, 'legacy.bookmarked'),
      retweeted_status_result: readRecordPath(row, 'legacy.retweeted_status_result'),
    },
  };
}

function createWorkerSearchRecordFromDocument(document: SearchDocumentRow): unknown {
  const entityId = document.raw_ref_key || document.entity_id;
  const primaryText = [document.primary_text, document.quoted_text, document.auxiliary_text]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n\n');

  return {
    rest_id: entityId,
    id_str: entityId,
    __bookmark_folder_id: document.folder_id,
    __bookmark_folder_name: document.folder_name,
    __route_type: document.route_type,
    core: {
      user_results: {
        result: {
          rest_id: document.author_id,
          core: {
            screen_name: document.author_screen_name,
            name: document.author_screen_name,
          },
          legacy: {
            screen_name: document.author_screen_name,
            name: document.author_screen_name,
          },
        },
      },
    },
    legacy: {
      id_str: entityId,
      full_text: primaryText,
      text: primaryText,
      created_at: document.created_at_ms
        ? new Date(document.created_at_ms).toUTCString()
        : undefined,
      lang: document.lang,
      favorite_count: document.numeric_json?.favorite_count,
      retweet_count: document.numeric_json?.retweet_count,
      reply_count: document.numeric_json?.reply_count,
      bookmark_count: document.numeric_json?.bookmark_count,
      quote_count: document.numeric_json?.quote_count,
    },
  };
}

function createWorkerSearchRowsFromDocuments(
  documents: SearchDocumentRow[],
  offset: number,
): SearchWorkerRecord[] {
  return documents.map((document, index) => ({
    id: document.raw_ref_key || document.entity_id || `search-doc-${offset + index}`,
    record: createWorkerSearchRecordFromDocument(document),
  }));
}

export function useResultSetController<T>({
  title,
  viewStateKey,
  fullscreen,
  onFullscreenChange,
  records,
  searchDocuments,
  searchDocumentsLoading = false,
  searchDocumentsLoaded = false,
  searchDocumentTotalCount = 0,
  searchDocumentsBlockedReason,
  loadSearchDocuments,
  loadSearchDocumentChunks,
  folderScopeSourceBacked = false,
  resultSourceDescriptor,
  resultSourceTotalCount,
  resultEntityType,
  hydrateRecordsByIds,
  columns,
  alternateViews,
}: UseResultSetControllerProps<T>) {
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectionMode, setSelectionMode] = useState<'all' | 'explicit'>('all');
  const [internalFullscreen, setInternalFullscreen] = useState(false);
  const [activeViewId, setActiveViewId] = useState<'table' | string>('table');
  const [asyncSearchState, setAsyncSearchState] = useState<AsyncSearchState<T> | null>(null);
  const [searchHydratedRecords, setSearchHydratedRecords] = useState<T[]>([]);
  const [folderHydrationAttemptState, setFolderHydrationAttemptState] =
    useState<FolderHydrationAttemptState>(() => ({ key: '', ids: new Set() }));
  const searchClientRef = useRef<SearchWorkerClient | null>(null);
  const latestSearchRequestIdRef = useRef('');
  const inFlightSearchKeyRef = useRef('');
  const completedSearchKeyRef = useRef('');
  const readyCorpusKeyRef = useRef('');
  const warmingCorpusKeyRef = useRef('');
  const warmingCorpusPromiseRef = useRef<ReturnType<SearchWorkerClient['setCorpus']> | null>(null);
  const activeFolderHydrationKeyRef = useRef('');
  const completedFolderHydrationKeyRef = useRef('');
  const normalizedSearchQuery = debouncedSearchQuery.trim();
  const hasSearchQuery = normalizedSearchQuery.length > 0;
  const hasFolderScope = selectedFolders.length > 0;
  const folderScopeUsesSource = hasFolderScope && folderScopeSourceBacked && !hasSearchQuery;
  const needsWorkerSearch = hasSearchQuery;
  const shouldUseSearchDocumentCorpus =
    (hasSearchQuery || (hasFolderScope && !folderScopeUsesSource)) &&
    (searchDocumentsLoaded || Boolean(searchDocuments?.length));
  const shouldPrepareWorkerCorpus = hasSearchQuery && shouldUseSearchDocumentCorpus;
  const shouldStreamSearchDocumentCorpus =
    shouldPrepareWorkerCorpus &&
    !searchDocuments?.length &&
    searchDocumentTotalCount > 0 &&
    Boolean(loadSearchDocumentChunks);
  const searchDebounceMs = useMemo(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return 60;

    const hasStructuredSyntax = /["():]|^[@#$-]/.test(trimmed);
    const tokenCount = trimmed.split(/\s+/).filter(Boolean).length;

    if (hasStructuredSyntax || tokenCount > 1) {
      return 180;
    }

    return 240;
  }, [searchQuery]);
  const isFullscreen = fullscreen ?? internalFullscreen;
  const setIsFullscreen = (value: boolean | ((current: boolean) => boolean)) => {
    const nextValue =
      typeof value === 'function' ? (value as (current: boolean) => boolean)(isFullscreen) : value;
    if (fullscreen === undefined) {
      setInternalFullscreen(nextValue);
    }
    onFullscreenChange?.(nextValue);
  };
  const resolvedViewStateKey = useMemo(
    () => `twe_table_view_state_v2:${viewStateKey || title}`,
    [title, viewStateKey],
  );
  const scopeKey = useMemo(() => {
    if (searchDocuments?.length || searchDocumentTotalCount > 0) {
      return `${resolvedViewStateKey}:search-documents:${searchDocumentTotalCount || searchDocuments?.length || 0}`;
    }
    return `${resolvedViewStateKey}:records:${records.length}`;
  }, [records.length, resolvedViewStateKey, searchDocumentTotalCount, searchDocuments?.length]);
  const selectedFolderKey = useMemo(() => [...selectedFolders].sort().join(','), [selectedFolders]);

  const recordIds = useMemo(
    () => records.map((record, index) => extractStableRecordId(record, index)),
    [records],
  );

  const corpusIdentityKey = useMemo(() => {
    if (searchDocuments?.length) {
      const first = searchDocuments[0];
      const last = searchDocuments[searchDocuments.length - 1];
      return [
        scopeKey,
        'docs',
        searchDocuments.length,
        first?.id || '',
        first?.updated_at_ms || '',
        last?.id || '',
        last?.updated_at_ms || '',
      ].join(':');
    }
    if (shouldStreamSearchDocumentCorpus) {
      return [scopeKey, 'docs-stream', searchDocumentTotalCount].join(':');
    }

    return [
      scopeKey,
      'records',
      records.length,
      recordIds[0] || '',
      recordIds[recordIds.length - 1] || '',
    ].join(':');
  }, [
    recordIds,
    records.length,
    scopeKey,
    searchDocumentTotalCount,
    searchDocuments,
    shouldStreamSearchDocumentCorpus,
  ]);

  const asyncSearchKey = `${corpusIdentityKey}:${normalizedSearchQuery}:${selectedFolderKey}`;

  const recordById = useMemo(() => {
    const map = new Map<string, T>();
    records.forEach((record, index) => {
      for (const id of collectRecordLookupIds(record, index)) {
        map.set(id, record);
      }
      map.set(recordIds[index] || `row-${index}`, record);
    });
    searchHydratedRecords.forEach((record, index) => {
      for (const id of collectRecordLookupIds(record, index)) {
        map.set(id, record);
      }
    });
    return map;
  }, [recordIds, records, searchHydratedRecords]);
  const recordByIdRef = useRef(recordById);

  useEffect(() => {
    recordByIdRef.current = recordById;
  }, [recordById]);

  useEffect(() => {
    recordPerfMetric({
      kind: 'viewer',
      name: 'table-record-lookup-ids',
      value: recordById.size,
      tags: {
        title,
        viewStateKey: viewStateKey || '',
        records: records.length,
        searchHydratedRecords: searchHydratedRecords.length,
      },
    });
  }, [recordById.size, records.length, searchHydratedRecords.length, title, viewStateKey]);

  useEffect(() => {
    setSearchHydratedRecords([]);
    setFolderHydrationAttemptState({ key: '', ids: new Set() });
    activeFolderHydrationKeyRef.current = '';
    completedFolderHydrationKeyRef.current = '';
    warmingCorpusPromiseRef.current = null;
    inFlightSearchKeyRef.current = '';
    completedSearchKeyRef.current = '';
  }, [scopeKey]);

  const searchDocumentCorpusRows = useMemo(() => {
    if (!shouldPrepareWorkerCorpus) return [];
    return (
      searchDocuments?.map((document, index) => ({
        id: document.raw_ref_key || document.entity_id || `search-doc-${index}`,
        record: createWorkerSearchRecordFromDocument(document),
      })) ?? []
    );
  }, [searchDocuments, shouldPrepareWorkerCorpus]);

  const recordCorpusRows = useMemo(() => {
    if (!hasSearchQuery || shouldUseSearchDocumentCorpus) return [];
    return records.map((record, index) => ({
      id: recordIds[index] || `row-${index}`,
      record: createWorkerSearchRecord(record),
    }));
  }, [hasSearchQuery, recordIds, records, shouldUseSearchDocumentCorpus]);

  const workerCorpusRows = shouldUseSearchDocumentCorpus
    ? searchDocumentCorpusRows
    : recordCorpusRows;
  const workerCorpusRowsRef = useRef(workerCorpusRows);
  const selectedFoldersRef = useRef(selectedFolders);
  const hydrateRecordsByIdsRef = useRef(hydrateRecordsByIds);

  useEffect(() => {
    recordPerfMetric({
      kind: 'search',
      name: 'worker-corpus-candidates',
      value: workerCorpusRows.length,
      tags: {
        title,
        viewStateKey: viewStateKey || '',
        source: shouldUseSearchDocumentCorpus ? 'search-documents' : 'records',
        records: records.length,
        searchDocuments: searchDocuments?.length ?? 0,
        searchDocumentTotalCount,
        searchDocumentsLoaded,
        searchDocumentsLoading,
        searchDocumentsBlocked: Boolean(searchDocumentsBlockedReason),
      },
    });
  }, [
    records.length,
    searchDocuments?.length,
    searchDocumentTotalCount,
    searchDocumentsBlockedReason,
    searchDocumentsLoaded,
    searchDocumentsLoading,
    shouldUseSearchDocumentCorpus,
    title,
    viewStateKey,
    workerCorpusRows.length,
  ]);

  useEffect(() => {
    workerCorpusRowsRef.current = workerCorpusRows;
  }, [workerCorpusRows]);

  useEffect(() => {
    if (!hasSearchQuery || !loadSearchDocuments || searchDocumentsBlockedReason) {
      return;
    }
    if (searchDocumentsLoaded || searchDocumentsLoading || searchDocuments?.length) return;
    void loadSearchDocuments().catch((error) => {
      recordPerfMetric({
        kind: 'search',
        name: 'lazy-search-documents-error',
        tags: { error: error instanceof Error ? error.message : String(error) },
      });
    });
  }, [
    hasFolderScope,
    hasSearchQuery,
    folderScopeUsesSource,
    loadSearchDocuments,
    searchDocumentsBlockedReason,
    searchDocuments?.length,
    searchDocumentsLoaded,
    searchDocumentsLoading,
  ]);

  useEffect(() => {
    selectedFoldersRef.current = selectedFolders;
  }, [selectedFolders]);

  useEffect(() => {
    hydrateRecordsByIdsRef.current = hydrateRecordsByIds;
  }, [hydrateRecordsByIds]);

  const folderScopedDocuments = useMemo(() => {
    if (folderScopeUsesSource || hasSearchQuery || !hasFolderScope || !searchDocuments?.length) {
      return [];
    }
    const folderIds = new Set(selectedFolders);
    return searchDocuments
      .filter((document) => document.folder_id && folderIds.has(document.folder_id))
      .sort((left, right) => {
        const rightTime = right.observed_at_ms || right.created_at_ms || right.updated_at_ms || 0;
        const leftTime = left.observed_at_ms || left.created_at_ms || left.updated_at_ms || 0;
        if (rightTime !== leftTime) return rightTime - leftTime;
        return (right.raw_ref_key || right.entity_id).localeCompare(
          left.raw_ref_key || left.entity_id,
        );
      });
  }, [folderScopeUsesSource, hasFolderScope, hasSearchQuery, searchDocuments, selectedFolders]);

  const folderScopedDocumentIds = useMemo(
    () =>
      folderScopedDocuments
        .map((document) => document.raw_ref_key || document.entity_id)
        .filter(Boolean)
        .slice(0, MAX_FOLDER_HYDRATE_RECORDS),
    [folderScopedDocuments],
  );

  const folderHydrationKey = useMemo(() => {
    if (!folderScopedDocumentIds.length) return '';
    const first = folderScopedDocumentIds[0] || '';
    const last = folderScopedDocumentIds[folderScopedDocumentIds.length - 1] || '';
    return `${scopeKey}:folders:${selectedFolderKey}:${folderScopedDocumentIds.length}:${first}:${last}`;
  }, [folderScopedDocumentIds, scopeKey, selectedFolderKey]);

  useEffect(() => {
    if (
      hasSearchQuery ||
      folderScopeUsesSource ||
      !hasFolderScope ||
      !folderScopedDocumentIds.length ||
      !hydrateRecordsByIds
    ) {
      return;
    }
    if (
      activeFolderHydrationKeyRef.current === folderHydrationKey ||
      completedFolderHydrationKeyRef.current === folderHydrationKey
    ) {
      return;
    }
    activeFolderHydrationKeyRef.current = folderHydrationKey;
    setFolderHydrationAttemptState((current) =>
      current.key === folderHydrationKey ? current : { key: folderHydrationKey, ids: new Set() },
    );
    let cancelled = false;

    const appendHydratedRecords = (hydratedRecords: T[]) => {
      if (!hydratedRecords.length) return;
      setSearchHydratedRecords((current) => {
        const currentIds = new Set(
          current.flatMap((record, index) => collectRecordLookupIds(record, index)),
        );
        const additions = hydratedRecords.filter((record, index) => {
          const ids = collectRecordLookupIds(record, index);
          if (ids.some((id) => currentIds.has(id))) return false;
          ids.forEach((id) => currentIds.add(id));
          return true;
        });
        return additions.length
          ? [...current, ...additions].slice(-MAX_FOLDER_HYDRATE_RECORDS)
          : current;
      });
    };

    const hydrate = async () => {
      const startedAt = nowMs();
      let hydratedCount = 0;
      const missingIds = folderScopedDocumentIds.filter((id) => !recordByIdRef.current.has(id));
      for (
        let offset = 0;
        offset < missingIds.length && !cancelled;
        offset += FOLDER_HYDRATE_BATCH_SIZE
      ) {
        const batch = missingIds.slice(offset, offset + FOLDER_HYDRATE_BATCH_SIZE);
        const hydratedRecords = await hydrateRecordsByIds(batch);
        if (cancelled || activeFolderHydrationKeyRef.current !== folderHydrationKey) return;
        hydratedCount += hydratedRecords.length;
        setFolderHydrationAttemptState((current) => {
          if (current.key !== folderHydrationKey) return current;
          const ids = new Set(current.ids);
          batch.forEach((id) => ids.add(id));
          return { key: folderHydrationKey, ids };
        });
        appendHydratedRecords(hydratedRecords);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      }
      if (!cancelled && activeFolderHydrationKeyRef.current === folderHydrationKey) {
        completedFolderHydrationKeyRef.current = folderHydrationKey;
        activeFolderHydrationKeyRef.current = '';
      }
      recordPerfMetric({
        kind: 'viewer',
        name: 'folder-result-hydrate',
        durationMs: nowMs() - startedAt,
        value: hydratedCount,
        tags: {
          selectedFolders: selectedFolderKey,
          totalMatches: folderScopedDocumentIds.length,
          missingIds: missingIds.length,
          batchSize: FOLDER_HYDRATE_BATCH_SIZE,
        },
      });
    };

    void hydrate().catch((error) => {
      if (activeFolderHydrationKeyRef.current === folderHydrationKey) {
        activeFolderHydrationKeyRef.current = '';
      }
      recordPerfMetric({
        kind: 'viewer',
        name: 'folder-result-hydrate-error',
        tags: { error: error instanceof Error ? error.message : String(error) },
      });
    });

    return () => {
      cancelled = true;
      if (activeFolderHydrationKeyRef.current === folderHydrationKey) {
        activeFolderHydrationKeyRef.current = '';
      }
    };
  }, [
    folderHydrationKey,
    folderScopedDocumentIds,
    folderScopeUsesSource,
    hasFolderScope,
    hasSearchQuery,
    hydrateRecordsByIds,
    selectedFolderKey,
  ]);

  useEffect(() => {
    const client = new SearchWorkerClient();
    searchClientRef.current = client;
    return () => {
      client.dispose();
      searchClientRef.current = null;
      readyCorpusKeyRef.current = '';
    };
  }, []);

  useEffect(() => {
    readyCorpusKeyRef.current = '';
    warmingCorpusKeyRef.current = '';
  }, [scopeKey]);

  useEffect(() => {
    const client = searchClientRef.current;
    if (
      !hasSearchQuery ||
      !client?.isAvailable() ||
      !workerCorpusRowsRef.current.length ||
      readyCorpusKeyRef.current === corpusIdentityKey ||
      warmingCorpusKeyRef.current === corpusIdentityKey
    ) {
      return;
    }

    let cancelled = false;
    const warmCorpus = () => {
      if (cancelled || readyCorpusKeyRef.current === corpusIdentityKey) return;
      warmingCorpusKeyRef.current = corpusIdentityKey;
      const startedAt = nowMs();
      const warmPromise = client.setCorpus(scopeKey, workerCorpusRowsRef.current);
      warmingCorpusPromiseRef.current = warmPromise;
      void warmPromise
        .then((response) => {
          if (cancelled) return;
          if (response.type === 'search:corpus-ready') {
            readyCorpusKeyRef.current = corpusIdentityKey;
            recordPerfMetric({
              kind: 'search',
              name: 'corpus-warm-ready',
              durationMs: nowMs() - startedAt,
              tags: { corpusSize: response.corpusSize },
            });
          }
        })
        .catch((error) => {
          if (cancelled) return;
          recordPerfMetric({
            kind: 'search',
            name: 'corpus-warm-error',
            durationMs: nowMs() - startedAt,
            tags: { error: error instanceof Error ? error.message : String(error) },
          });
        })
        .finally(() => {
          if (warmingCorpusKeyRef.current === corpusIdentityKey) {
            warmingCorpusKeyRef.current = '';
          }
          if (warmingCorpusPromiseRef.current === warmPromise) {
            warmingCorpusPromiseRef.current = null;
          }
        });
    };

    const timeoutHandle = globalThis.setTimeout(warmCorpus, 120);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timeoutHandle);
    };
  }, [corpusIdentityKey, hasSearchQuery, scopeKey]);

  useEffect(() => {
    if (!needsWorkerSearch) {
      inFlightSearchKeyRef.current = '';
      completedSearchKeyRef.current = '';
      setAsyncSearchState(null);
      return;
    }

    if (searchDocumentsBlockedReason) {
      setAsyncSearchState({
        key: asyncSearchKey,
        pending: false,
        phase: 'degraded',
        result: createEmptySearchResult<T>(normalizedSearchQuery, [searchDocumentsBlockedReason]),
        error: searchDocumentsBlockedReason,
      });
      incrementPerfCounter('search:large-corpus-blocked');
      return;
    }

    const client = searchClientRef.current;
    if (loadSearchDocuments && !searchDocumentsLoaded && !searchDocuments?.length) {
      setAsyncSearchState({
        key: asyncSearchKey,
        pending: true,
        phase: 'preparing-corpus',
        result: createEmptySearchResult<T>(normalizedSearchQuery),
      });
      return;
    }
    if (completedSearchKeyRef.current === asyncSearchKey) {
      return;
    }
    if (inFlightSearchKeyRef.current === asyncSearchKey) {
      return;
    }

    inFlightSearchKeyRef.current = asyncSearchKey;
    const requestId = createSearchRequestId();
    latestSearchRequestIdRef.current = requestId;
    const startedAt = nowMs();
    const queryText = normalizedSearchQuery;
    let cancelled = false;

    if (!client?.isAvailable()) {
      if (records.length <= 1500 || !searchDocuments?.length) {
        const fallback = runAdvancedTableSearch(records ?? [], queryText, {
          bookmarkFolderIds: selectedFoldersRef.current,
        });
        completedSearchKeyRef.current = asyncSearchKey;
        inFlightSearchKeyRef.current = '';
        const fallbackIds = fallback.records.map((record, index) =>
          extractHydrationRecordId(extractStableRecordId(record, index)),
        );
        setAsyncSearchState({
          key: asyncSearchKey,
          pending: false,
          phase: 'unavailable',
          result: fallback,
          resultIds: fallbackIds,
          error: 'Search worker unavailable; used bounded main-thread fallback.',
        });
        return;
      }
      const warning = searchDocuments?.length
        ? 'Search worker unavailable; large-corpus indexed folder/search hydration was blocked.'
        : 'Search worker unavailable; large-corpus main-thread search was blocked.';
      setAsyncSearchState({
        key: asyncSearchKey,
        pending: false,
        phase: 'unavailable',
        result: createEmptySearchResult<T>(queryText, [warning]),
        error: warning,
      });
      inFlightSearchKeyRef.current = '';
      incrementPerfCounter('search:large-fallback-blocked');
      return;
    }

    setAsyncSearchState((current) => ({
      key: asyncSearchKey,
      pending: true,
      phase: readyCorpusKeyRef.current === corpusIdentityKey ? 'querying' : 'preparing-corpus',
      result: current?.key === asyncSearchKey ? current.result : null,
    }));

    const run = async () => {
      if (readyCorpusKeyRef.current !== corpusIdentityKey) {
        const corpusStartedAt = nowMs();
        let corpusResponse = null;
        if (warmingCorpusKeyRef.current === corpusIdentityKey && warmingCorpusPromiseRef.current) {
          try {
            corpusResponse = await warmingCorpusPromiseRef.current;
          } catch {
            corpusResponse = null;
          }
        }
        if (
          (!corpusResponse || corpusResponse.type !== 'search:corpus-ready') &&
          shouldStreamSearchDocumentCorpus &&
          loadSearchDocumentChunks
        ) {
          let loadedRows = 0;
          client.beginCorpus({
            scopeKey,
            requestId,
            expectedCount: searchDocumentTotalCount,
          });
          const chunkResult = await loadSearchDocumentChunks({
            chunkSize: SEARCH_DOCUMENT_CORPUS_CHUNK_SIZE,
            isCancelled: () => cancelled || latestSearchRequestIdRef.current !== requestId,
            onChunk: (documents, progress) => {
              if (cancelled || latestSearchRequestIdRef.current !== requestId) return;
              const records = createWorkerSearchRowsFromDocuments(documents, loadedRows);
              loadedRows += records.length;
              client.appendCorpus({ scopeKey, requestId, records });
              recordPerfMetric({
                kind: 'search',
                name: 'chunked-corpus-transfer',
                value: progress.loaded,
                tags: {
                  totalCount: progress.totalCount,
                  chunkRows: records.length,
                  scopeKey,
                },
              });
            },
          });
          if (
            chunkResult.cancelled ||
            cancelled ||
            latestSearchRequestIdRef.current !== requestId
          ) {
            incrementPerfCounter('search:chunked-corpus-cancelled');
            return;
          }
          corpusResponse = await client.commitCorpus(scopeKey, requestId);
        }
        if (!corpusResponse || corpusResponse.type !== 'search:corpus-ready') {
          corpusResponse = await client.setCorpus(scopeKey, workerCorpusRowsRef.current);
        }
        if (latestSearchRequestIdRef.current !== requestId) {
          incrementPerfCounter('search:stale-corpus-ignored');
          return;
        }
        if (corpusResponse.type === 'search:corpus-ready') {
          readyCorpusKeyRef.current = corpusIdentityKey;
          setAsyncSearchState((current) =>
            current?.key === asyncSearchKey
              ? { ...current, pending: true, phase: 'querying' }
              : current,
          );
          recordPerfMetric({
            kind: 'search',
            name: 'corpus-ready',
            durationMs: nowMs() - corpusStartedAt,
            tags: { corpusSize: corpusResponse.corpusSize },
          });
        }
      }

      return await client.query({
        scopeKey,
        query: queryText,
        options: {
          bookmarkFolderIds: selectedFoldersRef.current,
          limit: MAX_QUERY_HYDRATE_RECORDS,
        },
        requestId,
      });
    };

    void run()
      .then((response) => {
        if (!response) {
          if (inFlightSearchKeyRef.current === asyncSearchKey) {
            inFlightSearchKeyRef.current = '';
          }
          return;
        }
        if (latestSearchRequestIdRef.current !== requestId) {
          if (inFlightSearchKeyRef.current === asyncSearchKey) {
            inFlightSearchKeyRef.current = '';
          }
          incrementPerfCounter('search:stale-ignored');
          return;
        }
        const currentRecordById = recordByIdRef.current;
        const resultRecords = response.ids
          .map((id) => currentRecordById.get(id))
          .filter((record): record is T => !!record);
        setAsyncSearchState({
          key: asyncSearchKey,
          pending: false,
          phase: 'ready',
          result: {
            ...response.result,
            records: resultRecords,
          },
          resultIds: response.ids,
        });
        completedSearchKeyRef.current = asyncSearchKey;
        if (inFlightSearchKeyRef.current === asyncSearchKey) {
          inFlightSearchKeyRef.current = '';
        }

        const hydrateLimit = hasSearchQuery
          ? MAX_QUERY_HYDRATE_RECORDS
          : MAX_FOLDER_HYDRATE_RECORDS;
        const activeHydrateRecordsByIds = hydrateRecordsByIdsRef.current;
        const missingIds = activeHydrateRecordsByIds
          ? response.ids.filter((id) => !currentRecordById.has(id)).slice(0, hydrateLimit)
          : [];
        if (missingIds.length) {
          const hydrateStartedAt = nowMs();
          void activeHydrateRecordsByIds?.(missingIds)
            .then((hydratedRecords) => {
              if (latestSearchRequestIdRef.current !== requestId) return;
              const hydratedMap = new Map(recordByIdRef.current);
              hydratedRecords.forEach((record, index) => {
                for (const id of collectRecordLookupIds(record, index)) {
                  hydratedMap.set(id, record);
                }
              });
              setSearchHydratedRecords((current) => {
                const currentIds = new Set(
                  current.flatMap((record, index) => collectRecordLookupIds(record, index)),
                );
                const additions = hydratedRecords.filter((record, index) => {
                  const ids = collectRecordLookupIds(record, index);
                  if (ids.some((id) => currentIds.has(id))) return false;
                  ids.forEach((id) => currentIds.add(id));
                  return true;
                });
                return additions.length
                  ? [...current, ...additions].slice(-MAX_FOLDER_HYDRATE_RECORDS)
                  : current;
              });
              const nextResultRecords = response.ids
                .map((id) => hydratedMap.get(id))
                .filter((record): record is T => !!record);
              setAsyncSearchState({
                key: asyncSearchKey,
                pending: false,
                phase: 'ready',
                result: {
                  ...response.result,
                  records: nextResultRecords,
                },
                resultIds: response.ids,
              });
              recordPerfMetric({
                kind: 'viewer',
                name: 'search-result-hydrate',
                durationMs: nowMs() - hydrateStartedAt,
                value: hydratedRecords.length,
                tags: { missingIds: missingIds.length, resultCount: response.ids.length },
              });
            })
            .catch((error) => {
              recordPerfMetric({
                kind: 'viewer',
                name: 'search-result-hydrate-error',
                durationMs: nowMs() - hydrateStartedAt,
                tags: { error: error instanceof Error ? error.message : String(error) },
              });
            });
        }
        recordPerfMetric({
          kind: 'search',
          name: 'query-total',
          durationMs: nowMs() - startedAt,
          tags: {
            corpusSize: response.corpusSize,
            resultCount: response.ids.length,
            queryLength: queryText.length,
          },
        });
      })
      .catch((error) => {
        if (latestSearchRequestIdRef.current !== requestId) return;
        const message = error instanceof Error ? error.message : String(error);
        setAsyncSearchState({
          key: asyncSearchKey,
          pending: false,
          phase: /cancelled/i.test(message) ? 'cancelled' : 'failed',
          result: createEmptySearchResult<T>(queryText, [message]),
          error: message,
        });
        if (inFlightSearchKeyRef.current === asyncSearchKey) {
          inFlightSearchKeyRef.current = '';
        }
        recordPerfMetric({
          kind: 'search',
          name: 'query-error',
          durationMs: nowMs() - startedAt,
          tags: { error: message, queryLength: queryText.length },
        });
      });

    return () => {
      cancelled = true;
      const wasInFlight = inFlightSearchKeyRef.current === asyncSearchKey;
      if (wasInFlight) {
        inFlightSearchKeyRef.current = '';
      }
      client.cancel(requestId);
      if (wasInFlight) {
        recordPerfMetric({
          kind: 'search',
          name: 'readiness-state',
          value: 1,
          tags: {
            phase: 'cancelled',
            queryLength: normalizedSearchQuery.length,
            corpusRows: workerCorpusRowsRef.current.length,
            searchDocuments: searchDocuments?.length ?? 0,
            searchDocumentsLoaded,
            searchDocumentsLoading,
            cancellable: false,
          },
        });
      }
      setAsyncSearchState((current) =>
        current?.key === asyncSearchKey && current.pending
          ? {
              ...current,
              pending: false,
              phase: 'cancelled',
              result: current.result ?? createEmptySearchResult<T>(normalizedSearchQuery),
              error: 'Search request cancelled.',
            }
          : current,
      );
    };
  }, [
    asyncSearchKey,
    hasSearchQuery,
    needsWorkerSearch,
    normalizedSearchQuery,
    corpusIdentityKey,
    scopeKey,
    loadSearchDocumentChunks,
    searchDocumentTotalCount,
    searchDocuments?.length,
    searchDocumentsLoaded,
    searchDocumentsLoading,
    searchDocumentsBlockedReason,
    shouldStreamSearchDocumentCorpus,
  ]);

  const searchResult = useMemo(() => {
    if (!hasSearchQuery && folderScopeUsesSource) {
      return createSearchResultFromRecords({
        query: '',
        records: records ?? [],
        totalMatches: records?.length ?? 0,
      });
    }

    if (!hasSearchQuery && hasFolderScope && searchDocuments?.length) {
      const attemptedIds =
        folderHydrationAttemptState.key === folderHydrationKey
          ? folderHydrationAttemptState.ids
          : new Set<string>();
      const recordsInOrder = resolveOrderedAvailableRecords(
        folderScopedDocumentIds,
        recordById,
        attemptedIds,
      );
      return createSearchResultFromRecords({
        query: '',
        records: recordsInOrder,
        totalMatches: folderScopedDocuments.length,
      });
    }

    if (!needsWorkerSearch) {
      return runAdvancedTableSearch(records ?? [], '', {
        bookmarkFolderIds: selectedFolders,
      });
    }
    if (asyncSearchState?.key === asyncSearchKey && asyncSearchState.result) {
      return asyncSearchState.result;
    }
    return createEmptySearchResult<T>(normalizedSearchQuery);
  }, [
    asyncSearchKey,
    asyncSearchState,
    folderScopedDocumentIds,
    folderScopedDocuments.length,
    folderHydrationAttemptState,
    folderHydrationKey,
    folderScopeUsesSource,
    hasFolderScope,
    hasSearchQuery,
    needsWorkerSearch,
    normalizedSearchQuery,
    recordById,
    records,
    searchDocuments?.length,
    selectedFolders,
  ]);

  const searchPending = !!(
    needsWorkerSearch &&
    asyncSearchState?.key === asyncSearchKey &&
    asyncSearchState.pending
  );
  const searchResultIds =
    hasSearchQuery && asyncSearchState?.key === asyncSearchKey
      ? (asyncSearchState.resultIds ?? [])
      : [];
  const streamSearchResultRows = useMemo(() => {
    if (
      !hasSearchQuery ||
      sorting.length ||
      !hydrateRecordsByIds ||
      !resultEntityType ||
      !searchResultIds.length
    ) {
      return undefined;
    }
    const source = createSearchResultSourceAdapter<T>({
      extensionName:
        resultSourceDescriptor &&
        'extensionName' in resultSourceDescriptor &&
        typeof resultSourceDescriptor.extensionName === 'string' &&
        resultSourceDescriptor.extensionName
          ? resultSourceDescriptor.extensionName
          : title,
      entityType: resultEntityType,
      query: normalizedSearchQuery,
      ids: searchResultIds,
      totalCount: searchResultIds.length,
      folderIds: selectedFolders,
      hydrateByIds: hydrateRecordsByIds,
    });
    return () => source.streamRows();
  }, [
    hasSearchQuery,
    hydrateRecordsByIds,
    normalizedSearchQuery,
    resultEntityType,
    resultSourceDescriptor,
    searchResultIds,
    selectedFolders,
    sorting.length,
    title,
  ]);
  const currentAsyncSearchState =
    asyncSearchState?.key === asyncSearchKey ? asyncSearchState : null;
  const searchReadinessState: SearchReadinessState = useMemo(() => {
    if (!hasSearchQuery) {
      return {
        phase: 'idle',
        label: searchReadinessLabel('idle'),
        cancellable: false,
      };
    }

    if (currentAsyncSearchState?.phase) {
      return {
        phase: currentAsyncSearchState.phase,
        label: searchReadinessLabel(currentAsyncSearchState.phase),
        detail: currentAsyncSearchState.error,
        cancellable:
          currentAsyncSearchState.pending &&
          (currentAsyncSearchState.phase === 'preparing-corpus' ||
            currentAsyncSearchState.phase === 'querying'),
      };
    }

    if (searchDocumentsBlockedReason) {
      return {
        phase: 'degraded',
        label: searchReadinessLabel('degraded'),
        detail: searchDocumentsBlockedReason,
        cancellable: false,
      };
    }

    if (loadSearchDocuments && !searchDocumentsLoaded && !searchDocuments?.length) {
      return {
        phase: 'preparing-corpus',
        label: searchReadinessLabel('preparing-corpus'),
        detail: searchDocumentsLoading ? 'loading search documents' : 'waiting for search corpus',
        cancellable: true,
      };
    }

    if (readyCorpusKeyRef.current === corpusIdentityKey) {
      return {
        phase: 'ready',
        label: searchReadinessLabel('ready'),
        cancellable: false,
      };
    }

    return {
      phase: 'preparing-corpus',
      label: searchReadinessLabel('preparing-corpus'),
      cancellable: true,
    };
  }, [
    corpusIdentityKey,
    currentAsyncSearchState,
    hasSearchQuery,
    loadSearchDocuments,
    searchDocuments?.length,
    searchDocumentsBlockedReason,
    searchDocumentsLoaded,
    searchDocumentsLoading,
  ]);

  useEffect(() => {
    recordPerfMetric({
      kind: 'search',
      name: 'readiness-state',
      value: hasSearchQuery ? 1 : 0,
      tags: {
        phase: searchReadinessState.phase,
        queryLength: normalizedSearchQuery.length,
        corpusRows: workerCorpusRows.length,
        searchDocuments: searchDocuments?.length ?? 0,
        searchDocumentsLoaded,
        searchDocumentsLoading,
        cancellable: searchReadinessState.cancellable,
      },
    });
  }, [
    hasSearchQuery,
    normalizedSearchQuery.length,
    searchDocuments?.length,
    searchDocumentsLoaded,
    searchDocumentsLoading,
    searchReadinessState.cancellable,
    searchReadinessState.phase,
    workerCorpusRows.length,
  ]);

  const sortableColumns = useMemo(() => {
    const leaves = flattenLeafColumns(columns);
    const map = new Map<string, ColumnDef<T>>();
    for (const column of leaves) {
      const id = resolveColumnId(column);
      if (id) {
        map.set(id, column);
      }
    }
    return map;
  }, [columns]);

  const sortedRecords = useMemo(() => {
    if (!sorting.length) {
      if (hasSearchQuery || (hasFolderScope && searchDocuments?.length)) {
        return searchResult.records;
      }

      return [...searchResult.records].sort((left, right) => {
        const rightRecency = resolveRecordRecency(right);
        const leftRecency = resolveRecordRecency(left);
        if (rightRecency !== leftRecency) {
          return rightRecency - leftRecency;
        }
        return 0;
      });
    }

    const indexMap = new Map<T, number>();
    searchResult.records.forEach((record, index) => {
      indexMap.set(record, index);
    });

    const sortable = [...searchResult.records];
    sortable.sort((left, right) => {
      const leftIndex = indexMap.get(left) ?? 0;
      const rightIndex = indexMap.get(right) ?? 0;

      for (const sortEntry of sorting) {
        const column = sortableColumns.get(sortEntry.id);
        if (!column) continue;
        const leftValue = resolveColumnValue(column, left, leftIndex);
        const rightValue = resolveColumnValue(column, right, rightIndex);
        const compared = compareSortValues(leftValue, rightValue);
        if (compared !== 0) {
          return sortEntry.desc ? -compared : compared;
        }
      }

      return leftIndex - rightIndex;
    });
    return sortable;
  }, [hasSearchQuery, searchResult.records, sortableColumns, sorting]);

  const currentResultIds = useMemo(
    () => sortedRecords.map((record, index) => extractStableRecordId(record, index)),
    [sortedRecords],
  );
  const descriptorBackedResultSet =
    Boolean(resultSourceDescriptor) &&
    !hasSearchQuery &&
    !sorting.length &&
    (!hasFolderScope || folderScopeUsesSource);

  const handleRowSelectionChange = (updater: Updater<RowSelectionState>) => {
    const next = functionalUpdate(updater, rowSelection);
    setRowSelection(next);

    if (!currentResultIds.length) {
      return;
    }

    const allSelected = currentResultIds.every((id) => !!next[id]);
    setSelectionMode(allSelected ? 'all' : 'explicit');
  };

  const selectedRecords = useMemo(() => {
    if (selectionMode === 'all') {
      return [];
    }
    return sortedRecords.filter((record, index) => {
      const id = extractStableRecordId(record, index);
      return !!rowSelection[id];
    });
  }, [rowSelection, selectionMode, sortedRecords]);
  const selectedRecordIds = useMemo(() => {
    if (selectionMode === 'all') {
      return [];
    }
    return Object.entries(rowSelection)
      .filter(([, selected]) => selected)
      .map(([id]) => id);
  }, [rowSelection, selectionMode]);

  const resultSetSnapshot: ResultSetSnapshot = useMemo(
    () =>
      createResultSetSnapshot({
        queryText: normalizedSearchQuery,
        sort: serializeSortingState(sorting),
        ids: descriptorBackedResultSet ? [] : currentResultIds,
        idsTruncated: descriptorBackedResultSet ? currentResultIds.length > 0 : false,
        sourceDescriptor: descriptorBackedResultSet ? resultSourceDescriptor : undefined,
        totalMatches: descriptorBackedResultSet
          ? (resultSourceTotalCount ?? searchResult.totalMatches)
          : searchResult.totalMatches,
        warnings: searchResult.warnings,
      }),
    [
      currentResultIds,
      descriptorBackedResultSet,
      normalizedSearchQuery,
      resultSourceDescriptor,
      resultSourceTotalCount,
      searchResult.totalMatches,
      searchResult.warnings,
      sorting,
    ],
  );

  useEffect(() => {
    const handle = globalThis.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, searchDebounceMs);

    return () => {
      globalThis.clearTimeout(handle);
    };
  }, [searchDebounceMs, searchQuery]);

  useEffect(() => {
    if (!alternateViews?.length && activeViewId !== 'table') {
      setActiveViewId('table');
      return;
    }
    if (activeViewId !== 'table' && !alternateViews?.some((view) => view.id === activeViewId)) {
      setActiveViewId('table');
    }
  }, [activeViewId, alternateViews]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(resolvedViewStateKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { fullscreen?: boolean; activeViewId?: string };
      if (fullscreen === undefined && typeof parsed.fullscreen === 'boolean') {
        setInternalFullscreen(parsed.fullscreen);
      }
      if (typeof parsed.activeViewId === 'string' && parsed.activeViewId.trim()) {
        setActiveViewId(parsed.activeViewId);
      }
    } catch {
      // ignore bad persisted UI state
    }
  }, [resolvedViewStateKey]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(
        resolvedViewStateKey,
        JSON.stringify({
          fullscreen: isFullscreen,
          activeViewId,
        }),
      );
    } catch {
      // ignore storage errors
    }
  }, [activeViewId, isFullscreen, resolvedViewStateKey]);

  return {
    searchQuery,
    setSearchQuery,
    normalizedSearchQuery,
    selectedFolders,
    setSelectedFolders,
    rowSelection,
    setRowSelection,
    sorting,
    setSorting,
    selectionMode,
    setSelectionMode,
    isFullscreen,
    setIsFullscreen,
    activeViewId,
    setActiveViewId,
    searchResult,
    searchPending,
    searchReadinessState,
    sortedRecords,
    currentResultIds,
    handleRowSelectionChange,
    selectedRecords,
    selectedRecordIds,
    streamSearchResultRows,
    resultSetSnapshot,
    resolvedViewStateKey,
  };
}
