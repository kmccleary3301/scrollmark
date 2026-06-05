import { ComponentType, JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { Modal, MultiSelect } from '@/components/common';
import { TranslationKey, useTranslation } from '@/i18n';
import {
  extractHydrationRecordId,
  extractStableRecordId,
  ResultSetSnapshot,
} from '@/utils/result-set';
import { SEARCH_OPERATOR_HELP_ENTRIES } from '@/utils/search-query';
import { appendSearchHistoryEntry, readSearchHistory } from '@/utils/search-history';
import { useSignalState, useToggle } from '@/utils/common';
import { nowMs, recordPerfMetric } from '@/core/perf/metrics';
import type { SearchDocumentRow } from '@/core/database/manager';
import type {
  ResultEntityType,
  ResultSourceDescriptor,
  ResultWindow,
  SearchDocumentResultCursor,
} from '@/core/database/result-source';
import { createExplicitSelectionResultSource } from '@/core/database/id-result-sources';
import { flexRender, useReactTable } from '@/utils/react-table';
import {
  IconInfoCircle,
  IconLayoutGrid,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconSearch,
  IconSortAscending,
  IconSortDescending,
  IconTable,
  IconX,
} from '@tabler/icons-preact';
import { ColumnDef, getCoreRowModel, Row, RowData, Table } from '@tanstack/table-core';

import { ExportDataModal } from '../modals/export-data';
import { useResultSetController } from './use-result-set-controller';

const VIRTUAL_OVERSCAN_ROWS = 12;
const VIRTUAL_INITIAL_ROW_HEIGHT = 74;
const VIEWER_PREFETCH_VIEWPORTS = 4;
const VIRTUAL_OVERSCAN_PX = 1600;
const VIRTUAL_MAX_WINDOW_ROWS = 90;
const VIRTUAL_SCROLL_UPDATE_PX = 24;
const ROW_HEIGHT_CACHE_LIMIT = 2500;
const LARGE_ALTERNATE_VIEW_SOURCE_THRESHOLD = 10_000;
const HIGHLIGHT_ATTRIBUTE = 'data-twe-highlight-v1';
const CSS_HIGHLIGHT_PREFIX = 'scrollmark-table-search-';

type CssHighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => boolean;
};

type CssHighlightConstructor = new (...ranges: Range[]) => unknown;
type RowHeightCacheEntry = {
  height: number;
  touchedAt: number;
};

const cssHighlightNamesByRoot = new WeakMap<HTMLElement, string>();
let cssHighlightId = 0;

// For opening media preview modal in column definitions.
declare module '@tanstack/table-core' {
  interface TableMeta<TData extends RowData> {
    mediaPreview: string;
    setMediaPreview: (url: string) => void;
    rawDataPreview: TData | null;
    setRawDataPreview: (data: TData | null) => void;
    isAllResultRowsSelected?: () => boolean;
    isSomeResultRowsSelected?: () => boolean;
    toggleAllResultRowsSelected?: () => void;
    isResultRowSelected?: (rowId: string) => boolean;
    toggleResultRowSelected?: (rowId: string) => void;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    exportable?: boolean;
    exportKey?: string;
    exportHeader?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exportValue?: (row: Row<TData>) => any;
  }
}

type BaseTableViewProps<T> = {
  title: string;
  viewStateKey?: string;
  searchHistoryScope?: string;
  fullscreen?: boolean;
  onFullscreenChange?: (value: boolean) => void;
  loading?: boolean;
  loadingMore?: boolean;
  loadedCount?: number;
  totalCount?: number;
  hasMore?: boolean;
  sourceMode?: boolean;
  sourceModeFiltersActive?: boolean;
  sourceWindowStartIndex?: number;
  resultSourceDescriptor?: ResultSourceDescriptor;
  resultEntityType?: ResultEntityType;
  onSourceWindowChange?: (startIndex: number, endIndex: number) => void;
  streamSourceRows?: () => AsyncIterable<T>;
  streamMediaRows?: () => AsyncIterable<T>;
  mediaSourceKey?: string;
  mediaSourceTotalCount?: number;
  getMediaWindow?: (
    startIndex: number,
    limit: number,
  ) => Promise<ResultWindow<T, SearchDocumentResultCursor>>;
  onBookmarkFolderSelectionChange?: (folderIds: string[]) => void;
  loadMore?: () => Promise<void>;
  loadAll?: () => Promise<void>;
  hydrateRecordsByIds?: (ids: string[]) => Promise<T[]>;
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
  columns: ColumnDef<T>[];
  clear: () => void;
  showClearButton?: boolean;
  renderActions?: (
    table: Table<T>,
    context: {
      loading: boolean;
      loadingMore: boolean;
      loadedCount: number;
      totalCount: number;
      resultRecords: T[];
      visibleRecords: T[];
    },
  ) => JSX.Element;
  renderExtra?: (table: Table<T>, context: BaseTableRenderContext<T>) => JSX.Element;
  bookmarkFolderOptions?: Array<{ label: string; value: string }>;
  alternateViews?: BaseTableAlternateView<T>[];
};

export type BaseTableRenderContext<T> = {
  resultSetSnapshot: ResultSetSnapshot;
  resultRecords: T[];
  selectedRecords: T[];
  selectionMode: 'all' | 'explicit';
  selectionExcludedRecordIds: string[];
};

export type BaseTableAlternateViewProps<T> = {
  records: T[];
  scrollParentRef: { current: HTMLElement | null };
  onOpenMedia: (url: string) => void;
  storageKey?: string;
  fullscreen?: boolean;
  sourceMode?: boolean;
  sourceTotalCount?: number;
  streamSourceRows?: () => AsyncIterable<T>;
  streamMediaRows?: () => AsyncIterable<T>;
  mediaSourceKey?: string;
  mediaSourceTotalCount?: number;
  getMediaWindow?: (
    startIndex: number,
    limit: number,
  ) => Promise<ResultWindow<T, SearchDocumentResultCursor>>;
  onDiagnosticsChange?: (diagnostics: BaseTableAlternateViewDiagnostics | null) => void;
};

export type BaseTableDiagnosticDetail = {
  key: string;
  label: string;
  minWidth?: 'sm' | 'md' | 'lg' | 'xl';
};

export type BaseTableAlternateViewDiagnostics = {
  primary: string;
  details?: BaseTableDiagnosticDetail[];
  actions?: JSX.Element;
};

export type BaseTableAlternateView<T> = {
  id: string;
  label: string;
  icon: 'table' | 'grid';
  sourceBacked?: boolean;
  component: ComponentType<BaseTableAlternateViewProps<T>>;
};

function unwrapHighlightMark(mark: HTMLElement) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
  parent.normalize();
}

function clearTextHighlights(root: HTMLElement) {
  const cssHighlightName = cssHighlightNamesByRoot.get(root);
  const cssHighlights = getCssHighlightRegistry();
  if (cssHighlightName && cssHighlights) {
    cssHighlights.delete(cssHighlightName);
    removeCssHighlightStyle(cssHighlightName);
  }

  // Remove marks left by older builds. The active highlighter uses CSS Highlight
  // ranges instead of DOM mutation so Preact-owned text nodes stay stable.
  const highlighted = root.querySelectorAll(`mark[${HIGHLIGHT_ATTRIBUTE}="1"]`);
  highlighted.forEach((node) => {
    if (node instanceof HTMLElement) {
      unwrapHighlightMark(node);
    }
  });
}

function getCssHighlightRegistry(): CssHighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: CssHighlightRegistry } }).CSS;
  const highlightCtor = getCssHighlightConstructor();
  if (!css?.highlights || !highlightCtor) return null;
  return css.highlights;
}

function getCssHighlightConstructor(): CssHighlightConstructor | null {
  const highlightCtor = (globalThis as { Highlight?: CssHighlightConstructor }).Highlight;
  return typeof highlightCtor === 'function' ? highlightCtor : null;
}

function getCssHighlightName(root: HTMLElement): string {
  const existing = cssHighlightNamesByRoot.get(root);
  if (existing) {
    ensureCssHighlightStyle(existing);
    return existing;
  }
  cssHighlightId += 1;
  const name = `${CSS_HIGHLIGHT_PREFIX}${cssHighlightId}`;
  cssHighlightNamesByRoot.set(root, name);
  ensureCssHighlightStyle(name);
  return name;
}

function diagnosticVisibilityClass(minWidth: BaseTableDiagnosticDetail['minWidth'] = 'sm'): string {
  switch (minWidth) {
    case 'md':
      return 'hidden md:inline';
    case 'lg':
      return 'hidden lg:inline';
    case 'xl':
      return 'hidden xl:inline';
    case 'sm':
    default:
      return 'hidden sm:inline';
  }
}

function ensureCssHighlightStyle(name: string) {
  if (typeof document === 'undefined') return;
  const id = `twe-css-highlight-style-${name}`;
  if (document.getElementById(id)) return;

  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
::highlight(${name}) {
  background-color: rgba(250, 204, 21, 0.32);
  color: inherit;
}
`;
  document.head.appendChild(style);
}

function removeCssHighlightStyle(name: string) {
  if (typeof document === 'undefined') return;
  document.getElementById(`twe-css-highlight-style-${name}`)?.remove();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyTextHighlights(root: HTMLElement, terms: string[]) {
  clearTextHighlights(root);
  if (!terms.length) return;

  const normalizedTerms = [...new Set(terms.map((term) => term.trim().toLowerCase()))]
    .filter((term) => term.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 24);
  if (!normalizedTerms.length) return;

  const cssHighlights = getCssHighlightRegistry();
  const HighlightCtor = getCssHighlightConstructor();
  if (!cssHighlights || !HighlightCtor) {
    return;
  }

  const pattern = new RegExp(
    `(${normalizedTerms.map((term) => escapeRegex(term)).join('|')})`,
    'ig',
  );

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (
        parent.closest(
          'mark,button,input,textarea,select,option,svg,code,pre,.btn,.checkbox,.label,.dropdown-content',
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }

  const ranges: Range[] = [];
  for (const node of textNodes) {
    const text = node.nodeValue || '';
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;

    pattern.lastIndex = 0;
    text.replace(pattern, (match: string, _capture: string, index: number) => {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + match.length);
      ranges.push(range);
      return match;
    });
  }

  if (!ranges.length) return;
  cssHighlights.set(getCssHighlightName(root), new HighlightCtor(...ranges));
}

function findVirtualIndexForOffset(offsets: number[], offset: number): number {
  if (offset <= 0 || offsets.length <= 1) return 0;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if ((offsets[mid] || 0) <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(0, Math.min(offsets.length - 2, low));
}

function trimRowHeightCache(cache: Map<string, RowHeightCacheEntry>) {
  if (cache.size <= ROW_HEIGHT_CACHE_LIMIT) return;
  const staleEntries = [...cache.entries()].sort(
    (left, right) => left[1].touchedAt - right[1].touchedAt,
  );
  for (const [key] of staleEntries.slice(0, cache.size - ROW_HEIGHT_CACHE_LIMIT)) {
    cache.delete(key);
  }
}

/**
 * Basic table view.
 */
export function BaseTableView<T>({
  title,
  viewStateKey,
  searchHistoryScope,
  fullscreen,
  onFullscreenChange,
  loading = false,
  loadingMore = false,
  loadedCount = 0,
  totalCount = 0,
  hasMore = false,
  sourceMode = false,
  sourceModeFiltersActive = false,
  sourceWindowStartIndex = 0,
  resultSourceDescriptor,
  resultEntityType,
  onSourceWindowChange,
  streamSourceRows,
  streamMediaRows,
  mediaSourceKey,
  mediaSourceTotalCount,
  getMediaWindow,
  onBookmarkFolderSelectionChange,
  loadMore,
  loadAll,
  hydrateRecordsByIds,
  records,
  searchDocuments,
  searchDocumentsLoading,
  searchDocumentsLoaded,
  searchDocumentTotalCount,
  searchDocumentsBlockedReason,
  loadSearchDocuments,
  loadSearchDocumentChunks,
  columns,
  clear,
  showClearButton = true,
  renderActions,
  renderExtra,
  bookmarkFolderOptions,
  alternateViews,
}: BaseTableViewProps<T>) {
  const { t } = useTranslation();
  const openedAtRef = useRef(nowMs());
  const firstRowsReportedRef = useRef(false);
  const firstInteractiveReportedRef = useRef(false);
  const firstStableLayoutReportedRef = useRef(false);

  // Control modal visibility for previewing media and JSON data.
  const [mediaPreview, setMediaPreview] = useSignalState('');
  const [showMediaModal, setShowMediaModal] = useSignalState(false);
  const [rawDataPreview, setRawDataPreview] = useSignalState<T | null>(null);

  const [showSearchHelp, toggleShowSearchHelp] = useToggle(false);
  const [searchHistoryCount, setSearchHistoryCount] = useState(0);
  const {
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
  } = useResultSetController({
    title,
    viewStateKey,
    fullscreen,
    onFullscreenChange,
    records,
    columns,
    alternateViews,
    searchDocuments,
    searchDocumentsLoading,
    searchDocumentsLoaded,
    searchDocumentTotalCount,
    searchDocumentsBlockedReason,
    loadSearchDocuments,
    loadSearchDocumentChunks,
    hydrateRecordsByIds,
    folderScopeSourceBacked: sourceModeFiltersActive,
    resultSourceDescriptor,
    resultEntityType,
    resultSourceTotalCount: totalCount,
  });

  const operatorHelpGroups = useMemo(() => {
    const groups = new Map<string, typeof SEARCH_OPERATOR_HELP_ENTRIES>();
    for (const entry of SEARCH_OPERATOR_HELP_ENTRIES) {
      const rows = groups.get(entry.category) || [];
      rows.push(entry);
      groups.set(entry.category, rows);
    }
    return [...groups.entries()];
  }, []);
  const activeAlternateView = useMemo(
    () => alternateViews?.find((view) => view.id === activeViewId) ?? null,
    [activeViewId, alternateViews],
  );
  const tableTelemetryActive = !activeAlternateView;
  const [alternateDiagnostics, setAlternateDiagnostics] =
    useState<BaseTableAlternateViewDiagnostics | null>(null);
  const handleAlternateDiagnosticsChange = useCallback(
    (diagnostics: BaseTableAlternateViewDiagnostics | null) => {
      setAlternateDiagnostics(diagnostics);
    },
    [],
  );
  useEffect(() => {
    setAlternateDiagnostics(null);
  }, [activeAlternateView?.id]);
  const activeAlternateViewBlocked =
    Boolean(activeAlternateView) &&
    sourceMode &&
    totalCount > LARGE_ALTERNATE_VIEW_SOURCE_THRESHOLD &&
    activeAlternateView?.sourceBacked !== true &&
    !normalizedSearchQuery;
  const handleBookmarkFolderSelectionChange = (folderIds: string[]) => {
    onBookmarkFolderSelectionChange?.(folderIds);
    setSelectedFolders(folderIds);
  };

  useEffect(() => {
    onBookmarkFolderSelectionChange?.(selectedFolders);
  }, [onBookmarkFolderSelectionChange, selectedFolders]);
  const metricTags = useMemo(
    () => ({
      title,
      viewStateKey: viewStateKey || '',
      resolvedViewStateKey,
      activeViewId,
      fullscreen: isFullscreen,
    }),
    [activeViewId, isFullscreen, resolvedViewStateKey, title, viewStateKey],
  );

  useEffect(() => {
    recordPerfMetric({
      kind: 'viewer',
      name: 'table-open-start',
      value: totalCount,
      tags: {
        ...metricTags,
        loadedCount,
        totalCount,
        searchDocuments: searchDocuments?.length ?? 0,
      },
    });
  }, []);

  // Infinite scrolling batch renderer.
  const scrollAreaRef = useRef<HTMLElement | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const scrollTopRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);
  const rowHeightsRef = useRef(new Map<string, RowHeightCacheEntry>());
  const highlightHadTermsRef = useRef(false);
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const [estimatedRowHeight, setEstimatedRowHeight] = useState(VIRTUAL_INITIAL_ROW_HEIGHT);
  const [rowHeightsVersion, setRowHeightsVersion] = useState(0);
  useEffect(() => {
    const area = scrollAreaRef.current;
    if (area) {
      area.scrollTop = 0;
      scrollTopRef.current = 0;
      setVirtualScrollTop(0);
      setViewportHeight(Math.max(320, area.clientHeight || 520));
    }
  }, [activeViewId, normalizedSearchQuery, selectedFolders]);

  const onTableScroll = () => {
    const area = scrollAreaRef.current;
    if (!area) return;
    scrollTopRef.current = area.scrollTop;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const nextTop = scrollTopRef.current;
      setVirtualScrollTop((current) => {
        if (Math.abs(nextTop - current) < VIRTUAL_SCROLL_UPDATE_PX) {
          return current;
        }
        return nextTop;
      });
    });
  };

  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!area || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const nextHeight = Math.max(320, area.clientHeight || 520);
      setViewportHeight((current) => (Math.abs(current - nextHeight) > 12 ? nextHeight : current));
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const safeRowHeight = Math.max(32, estimatedRowHeight || VIRTUAL_INITIAL_ROW_HEIGHT);
  const sourceDescriptorBrowsing =
    sourceMode &&
    !normalizedSearchQuery &&
    (!selectedFolders.length || sourceModeFiltersActive) &&
    !activeAlternateView;
  const sourceSortingDisabled = sourceDescriptorBrowsing && totalCount > records.length;
  const sourceBrowsingActive = sourceDescriptorBrowsing && !sorting.length;
  const totalRows = sourceBrowsingActive
    ? Math.max(totalCount, records.length)
    : sortedRecords.length;
  const rowKeys = currentResultIds;
  const virtualOffsets = useMemo(() => {
    if (sourceBrowsingActive) return [];
    const offsets = new Array<number>(totalRows + 1);
    offsets[0] = 0;
    for (let index = 0; index < totalRows; index += 1) {
      const key = rowKeys[index] || `row-${index}`;
      const height = rowHeightsRef.current.get(key)?.height || safeRowHeight;
      offsets[index + 1] = (offsets[index] || 0) + Math.max(24, height);
    }
    return offsets;
  }, [rowHeightsVersion, rowKeys, safeRowHeight, sourceBrowsingActive, totalRows]);
  const totalVirtualHeight = sourceBrowsingActive
    ? totalRows * safeRowHeight
    : virtualOffsets[totalRows] || 0;
  const startIndex = sourceBrowsingActive
    ? Math.max(
        0,
        Math.floor(Math.max(0, virtualScrollTop - VIRTUAL_OVERSCAN_PX) / safeRowHeight) -
          VIRTUAL_OVERSCAN_ROWS,
      )
    : Math.max(
        0,
        findVirtualIndexForOffset(virtualOffsets, virtualScrollTop - VIRTUAL_OVERSCAN_PX) -
          VIRTUAL_OVERSCAN_ROWS,
      );
  const requestedEndIndex = sourceBrowsingActive
    ? Math.ceil((virtualScrollTop + viewportHeight + VIRTUAL_OVERSCAN_PX) / safeRowHeight) +
      VIRTUAL_OVERSCAN_ROWS +
      1
    : findVirtualIndexForOffset(
        virtualOffsets,
        virtualScrollTop + viewportHeight + VIRTUAL_OVERSCAN_PX,
      ) +
      VIRTUAL_OVERSCAN_ROWS +
      1;
  const endIndex = Math.min(
    totalRows,
    Math.max(startIndex + 1, Math.min(requestedEndIndex, startIndex + VIRTUAL_MAX_WINDOW_ROWS)),
  );
  const sourceWindowEndIndex = sourceWindowStartIndex + records.length;
  const sourceRenderStartIndex = sourceBrowsingActive
    ? Math.max(sourceWindowStartIndex, Math.min(startIndex, sourceWindowEndIndex))
    : startIndex;
  const sourceRenderEndIndex = sourceBrowsingActive
    ? Math.max(sourceRenderStartIndex, Math.min(endIndex, sourceWindowEndIndex, totalRows))
    : endIndex;
  const visibleRecords = useMemo(() => {
    if (sourceBrowsingActive) {
      const offsetStart = Math.max(0, sourceRenderStartIndex - sourceWindowStartIndex);
      const offsetEnd = Math.max(offsetStart, sourceRenderEndIndex - sourceWindowStartIndex);
      return records.slice(offsetStart, offsetEnd);
    }
    return sortedRecords.slice(startIndex, endIndex);
  }, [
    endIndex,
    records,
    sortedRecords,
    sourceBrowsingActive,
    sourceRenderEndIndex,
    sourceRenderStartIndex,
    sourceWindowStartIndex,
    startIndex,
  ]);

  useEffect(() => {
    if (!sourceBrowsingActive || !onSourceWindowChange) return;
    const paddedStart = Math.max(0, startIndex - VIRTUAL_OVERSCAN_ROWS);
    const paddedEnd = Math.min(totalRows, endIndex + VIRTUAL_OVERSCAN_ROWS);
    onSourceWindowChange(paddedStart, paddedEnd);
  }, [endIndex, onSourceWindowChange, sourceBrowsingActive, startIndex, totalRows]);

  useEffect(() => {
    if (
      sourceBrowsingActive ||
      !hasMore ||
      loading ||
      loadingMore ||
      activeAlternateView ||
      normalizedSearchQuery
    ) {
      return;
    }
    const remainingPx = Math.max(0, totalVirtualHeight - (virtualScrollTop + viewportHeight));
    const prefetchThresholdPx = Math.max(
      900,
      viewportHeight * VIEWER_PREFETCH_VIEWPORTS,
      safeRowHeight * 80,
    );
    if (
      totalRows > 0 &&
      (endIndex >= totalRows - VIRTUAL_OVERSCAN_ROWS || remainingPx <= prefetchThresholdPx)
    ) {
      void loadMore?.();
    }
  }, [
    activeAlternateView,
    endIndex,
    hasMore,
    loadMore,
    loading,
    loadingMore,
    normalizedSearchQuery,
    safeRowHeight,
    totalVirtualHeight,
    totalRows,
    virtualScrollTop,
    viewportHeight,
  ]);

  const visibleStartIndex = sourceBrowsingActive ? sourceRenderStartIndex : startIndex;
  const visibleEndIndex = sourceBrowsingActive
    ? Math.min(totalRows, sourceRenderStartIndex + visibleRecords.length)
    : endIndex;
  const selectionExcludedRecordIds = useMemo(
    () =>
      selectionMode === 'all'
        ? Object.entries(rowSelection)
            .filter(([, excluded]) => excluded)
            .map(([id]) => id)
        : [],
    [rowSelection, selectionMode],
  );
  const selectionExceptionCount = selectionExcludedRecordIds.length;
  const selectedResultCount =
    selectionMode === 'all'
      ? Math.max(0, totalRows - selectionExceptionCount)
      : selectedRecordIds.length;
  const streamSelectedSourceRows = useMemo(() => {
    if (
      selectionMode !== 'explicit' ||
      !selectedRecordIds.length ||
      !hydrateRecordsByIds ||
      !resultSourceDescriptor ||
      !resultEntityType
    ) {
      return undefined;
    }
    const hydrationIds = selectedRecordIds
      .map((id) => extractHydrationRecordId(id))
      .filter((id) => id.length > 0);
    if (!hydrationIds.length) {
      return undefined;
    }
    const selectedSource = createExplicitSelectionResultSource<T>({
      extensionName:
        'extensionName' in resultSourceDescriptor
          ? resultSourceDescriptor.extensionName
          : undefined,
      entityType: resultEntityType,
      ids: hydrationIds,
      source: resultSourceDescriptor,
      hydrateByIds: hydrateRecordsByIds,
    });
    return () => selectedSource.streamRows();
  }, [
    hydrateRecordsByIds,
    resultEntityType,
    resultSourceDescriptor,
    selectedRecordIds,
    selectionMode,
  ]);
  const topSpacerHeight = sourceBrowsingActive
    ? visibleStartIndex * safeRowHeight
    : virtualOffsets[startIndex] || 0;
  const bottomSpacerHeight = Math.max(
    0,
    totalVirtualHeight -
      (sourceBrowsingActive
        ? visibleEndIndex * safeRowHeight
        : virtualOffsets[endIndex] || totalVirtualHeight),
  );

  useEffect(() => {
    if (!sourceSortingDisabled || !sorting.length) return;
    setSorting([]);
    recordPerfMetric({
      kind: 'viewer',
      name: 'source-sort-cleared',
      value: totalCount,
      tags: metricTags,
    });
  }, [metricTags, setSorting, sorting.length, sourceSortingDisabled, totalCount]);

  const toggleResultRowSelected = (rowId: string) => {
    if (selectionMode === 'all') {
      setRowSelection((current) => {
        const next = { ...current };
        if (next[rowId]) {
          delete next[rowId];
        } else {
          next[rowId] = true;
        }
        recordPerfMetric({
          kind: 'viewer',
          name: 'selection-all-exception-toggle',
          value: Object.keys(next).length,
          tags: {
            ...metricTags,
            totalRows,
            rowId,
          },
        });
        return next;
      });
      recordPerfMetric({
        kind: 'viewer',
        name: 'selection-mode-retained-all',
        value: Math.max(0, totalRows - 1),
        tags: {
          ...metricTags,
          totalRows,
          rowId,
        },
      });
      return;
    }
    handleRowSelectionChange((current) => ({
      ...current,
      [rowId]: !current[rowId],
    }));
  };

  const toggleAllResultRowsSelected = () => {
    if (selectionMode === 'all') {
      if (selectionExceptionCount > 0) {
        setRowSelection({});
        recordPerfMetric({
          kind: 'viewer',
          name: 'selection-all-exceptions-cleared',
          value: totalRows,
          tags: metricTags,
        });
        return;
      }
      setSelectionMode('explicit');
      setRowSelection({});
      recordPerfMetric({
        kind: 'viewer',
        name: 'selection-all-cleared',
        value: 0,
        tags: metricTags,
      });
      return;
    }

    const allVisibleSelected =
      currentResultIds.length > 0 && currentResultIds.every((id) => !!rowSelection[id]);
    if (allVisibleSelected) {
      setRowSelection({});
      recordPerfMetric({
        kind: 'viewer',
        name: 'selection-explicit-visible-cleared',
        value: 0,
        tags: metricTags,
      });
      return;
    }

    setSelectionMode('all');
    setRowSelection({});
    recordPerfMetric({
      kind: 'viewer',
      name: 'selection-explicit-promoted-all',
      value: totalRows,
      tags: metricTags,
    });
  };

  const table = useReactTable<T>({
    data: visibleRecords,
    columns,
    defaultColumn: {
      size: 160,
      minSize: 48,
      maxSize: 520,
    },
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (record, index) => extractStableRecordId(record, visibleStartIndex + index),
    enableSorting: !sourceSortingDisabled,
    manualSorting: true,
    onSortingChange: setSorting,
    onRowSelectionChange: handleRowSelectionChange,
    state: {
      rowSelection,
      sorting,
    },
    meta: {
      mediaPreview,
      setMediaPreview: (url) => {
        setMediaPreview(url);
        setShowMediaModal(true);
      },
      rawDataPreview,
      setRawDataPreview: (data) => setRawDataPreview(data),
      isAllResultRowsSelected: () =>
        selectionMode === 'all'
          ? currentResultIds.length > 0 && selectionExceptionCount === 0
          : currentResultIds.length > 0 && currentResultIds.every((id) => !!rowSelection[id]),
      isSomeResultRowsSelected: () =>
        selectionMode === 'all'
          ? selectionExceptionCount > 0
          : currentResultIds.some((id) => !!rowSelection[id]),
      toggleAllResultRowsSelected,
      isResultRowSelected: (rowId) =>
        selectionMode === 'all' ? !rowSelection[rowId] : !!rowSelection[rowId],
      toggleResultRowSelected,
    },
  });
  const visibleRows = table.getRowModel().rows;
  const visibleLeafColumns = table.getVisibleLeafColumns();
  const stableTableWidth = visibleLeafColumns.reduce((sum, column) => sum + column.getSize(), 0);

  useEffect(() => {
    if (firstRowsReportedRef.current || !visibleRows.length) return;
    firstRowsReportedRef.current = true;
    recordPerfMetric({
      kind: 'viewer',
      name: 'first-visible-rows',
      durationMs: nowMs() - openedAtRef.current,
      value: visibleRows.length,
      tags: {
        ...metricTags,
        hydratedRecords: records.length,
        totalRows,
        loadedCount,
        totalCount,
        searchDocuments: searchDocuments?.length ?? 0,
        visibleRows: visibleRows.length,
        loading,
      },
    });
  }, [
    loadedCount,
    loading,
    metricTags,
    records.length,
    searchDocuments?.length,
    totalCount,
    totalRows,
    visibleRows.length,
  ]);

  useEffect(() => {
    if (firstInteractiveReportedRef.current || loading || !visibleRows.length) return;
    firstInteractiveReportedRef.current = true;
    recordPerfMetric({
      kind: 'viewer',
      name: 'first-interactive',
      durationMs: nowMs() - openedAtRef.current,
      value: visibleRows.length,
      tags: {
        ...metricTags,
        hydratedRecords: records.length,
        loadedCount,
        totalCount,
        totalRows,
        visibleRows: visibleRows.length,
      },
    });
  }, [loadedCount, loading, metricTags, records.length, totalCount, totalRows, visibleRows.length]);

  useEffect(() => {
    if (firstStableLayoutReportedRef.current || loading || loadingMore || !visibleRows.length) {
      return;
    }
    const handle = globalThis.setTimeout(() => {
      if (firstStableLayoutReportedRef.current) return;
      firstStableLayoutReportedRef.current = true;
      recordPerfMetric({
        kind: 'viewer',
        name: 'first-stable-layout',
        durationMs: nowMs() - openedAtRef.current,
        value: visibleRows.length,
        tags: {
          ...metricTags,
          hydratedRecords: records.length,
          loadedCount,
          totalCount,
          totalRows,
          visibleRows: visibleRows.length,
          safeRowHeight,
          measuredRows: rowHeightsRef.current.size,
          virtualHeight: totalVirtualHeight,
        },
      });
    }, 350);
    return () => globalThis.clearTimeout(handle);
  }, [
    loadedCount,
    loading,
    loadingMore,
    metricTags,
    records.length,
    safeRowHeight,
    totalCount,
    totalRows,
    totalVirtualHeight,
    visibleRows.length,
  ]);

  useEffect(() => {
    recordPerfMetric({
      kind: 'viewer',
      name: 'table-hydrated-records',
      value: records.length,
      tags: metricTags,
    });
    recordPerfMetric({
      kind: 'viewer',
      name: 'table-search-documents',
      value: searchDocuments?.length ?? 0,
      tags: metricTags,
    });
    recordPerfMetric({
      kind: 'viewer',
      name: 'table-result-ids',
      value: currentResultIds.length,
      tags: metricTags,
    });
    recordPerfMetric({
      kind: 'viewer',
      name: 'table-selected-records',
      value: selectedRecords.length,
      tags: { ...metricTags, selectionMode },
    });
    recordPerfMetric({
      kind: 'viewer',
      name: 'table-selection-exceptions',
      value: selectionExceptionCount,
      tags: { ...metricTags, selectionMode },
    });
    recordPerfMetric({
      kind: 'viewer',
      name: 'table-selected-result-count',
      value: selectedResultCount,
      tags: { ...metricTags, selectionMode },
    });
    recordPerfMetric({
      kind: 'viewer',
      name: 'table-visible-rows',
      value: visibleRows.length,
      tags: { ...metricTags, startIndex, endIndex },
    });
  }, [
    currentResultIds.length,
    endIndex,
    metricTags,
    records.length,
    searchDocuments?.length,
    selectedRecords.length,
    selectedResultCount,
    selectionExceptionCount,
    selectionMode,
    startIndex,
    visibleRows.length,
  ]);

  useEffect(() => {
    const body = tbodyRef.current;
    if (!body) return;
    const renderedRows = body.querySelectorAll('tr[data-vrow="1"]');
    if (!renderedRows.length) return;

    let totalHeight = 0;
    let measuredCount = 0;
    let changed = false;
    renderedRows.forEach((row) => {
      if (row instanceof HTMLTableRowElement) {
        const measuredHeight = row.getBoundingClientRect().height;
        totalHeight += measuredHeight;
        measuredCount += 1;
        const key = row.dataset.vrowKey;
        if (key && Number.isFinite(measuredHeight) && measuredHeight > 0) {
          const previous = rowHeightsRef.current.get(key);
          if (!previous || Math.abs(previous.height - measuredHeight) > 2) {
            rowHeightsRef.current.set(key, {
              height: measuredHeight,
              touchedAt: nowMs(),
            });
            trimRowHeightCache(rowHeightsRef.current);
            changed = true;
          } else {
            previous.touchedAt = nowMs();
          }
        }
      }
    });
    const average = totalHeight / measuredCount;
    if (Number.isFinite(average) && average > 16) {
      setEstimatedRowHeight((current) => {
        const next = Math.max(24, current * 0.85 + average * 0.15);
        return Math.abs(next - current) > 3 ? next : current;
      });
    }
    if (changed) {
      setRowHeightsVersion((version) => version + 1);
      recordPerfMetric({
        kind: 'viewer',
        name: 'table-row-height-cache',
        value: rowHeightsRef.current.size,
        tags: {
          ...metricTags,
          limit: ROW_HEIGHT_CACHE_LIMIT,
          measuredRows: measuredCount,
          visibleRows: visibleRows.length,
        },
      });
    }
  }, [endIndex, metricTags, normalizedSearchQuery, selectedFolders, startIndex, visibleRows]);

  useEffect(() => {
    const root = tbodyRef.current;
    if (!root) return;
    if (!searchResult.highlightTerms.length) {
      if (highlightHadTermsRef.current) {
        clearTextHighlights(root);
        highlightHadTermsRef.current = false;
      }
      return;
    }
    highlightHadTermsRef.current = true;
    applyTextHighlights(root, searchResult.highlightTerms);
    return () => {
      clearTextHighlights(root);
    };
  }, [visibleRows, searchResult.highlightTerms]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  const lastSearchHistoryKeyRef = useRef('');
  const pendingSearchHistoryWriteRef = useRef<number | null>(null);
  useEffect(() => {
    if (!searchHistoryScope || typeof localStorage === 'undefined') {
      return;
    }
    setSearchHistoryCount(readSearchHistory(searchHistoryScope).length);
  }, [searchHistoryScope]);

  useEffect(() => {
    if (!searchHistoryScope) return;

    if (!normalizedSearchQuery) {
      lastSearchHistoryKeyRef.current = '';
      return;
    }

    const folderKey = [...selectedFolders].sort().join(',');
    const identity = `${searchHistoryScope}::${normalizedSearchQuery}::${folderKey}`;
    if (lastSearchHistoryKeyRef.current === identity) {
      return;
    }

    lastSearchHistoryKeyRef.current = identity;

    const scheduleWrite = () => {
      const next = appendSearchHistoryEntry({
        scope: searchHistoryScope,
        title,
        query: searchQuery,
        normalized_query: normalizedSearchQuery,
        searched_at_ms: Date.now(),
        result_count: searchResult.totalMatches,
        total_records: records.length,
        selected_folders: selectedFolders,
        lexical_expression: searchResult.parsed.lexicalExpression,
        warning_messages: searchResult.warnings,
      });
      setSearchHistoryCount(next.filter((entry) => entry.scope === searchHistoryScope).length);
    };

    if (
      typeof window !== 'undefined' &&
      'requestIdleCallback' in window &&
      typeof (window as Window & { requestIdleCallback?: unknown }).requestIdleCallback ===
        'function'
    ) {
      pendingSearchHistoryWriteRef.current = (
        window as Window & { requestIdleCallback: (callback: IdleRequestCallback) => number }
      ).requestIdleCallback(() => {
        pendingSearchHistoryWriteRef.current = null;
        scheduleWrite();
      });
    } else {
      pendingSearchHistoryWriteRef.current = window.setTimeout(() => {
        pendingSearchHistoryWriteRef.current = null;
        scheduleWrite();
      }, 160);
    }

    return () => {
      if (pendingSearchHistoryWriteRef.current === null) return;
      if (
        typeof window !== 'undefined' &&
        'cancelIdleCallback' in window &&
        typeof (window as Window & { cancelIdleCallback?: unknown }).cancelIdleCallback ===
          'function'
      ) {
        (window as Window & { cancelIdleCallback: (handle: number) => void }).cancelIdleCallback(
          pendingSearchHistoryWriteRef.current,
        );
      } else {
        window.clearTimeout(pendingSearchHistoryWriteRef.current);
      }
      pendingSearchHistoryWriteRef.current = null;
    };
  }, [
    records.length,
    searchHistoryScope,
    searchQuery,
    searchResult.parsed.lexicalExpression,
    searchResult.totalMatches,
    searchResult.warnings,
    normalizedSearchQuery,
    selectedFolders,
    title,
  ]);

  useEffect(() => {
    if (!isFullscreen || typeof document === 'undefined') return;

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [isFullscreen]);

  // Control modal visibility for exporting data.
  const [showExportDataModal, toggleShowExportDataModal] = useToggle();
  const [preparingExport, setPreparingExport] = useState(false);

  const openExportDataModal = () => {
    toggleShowExportDataModal();
    if (hasMore && !normalizedSearchQuery && loadAll && !preparingExport) {
      setPreparingExport(true);
      void loadAll().finally(() => {
        setPreparingExport(false);
      });
    }
  };

  const rootClass = isFullscreen
    ? 'relative flex min-h-0 grow flex-col overflow-hidden bg-base-100 text-base-content'
    : 'relative flex min-h-0 grow flex-col';

  const ActiveAlternateView = activeAlternateView?.component;

  return (
    <div class={rootClass}>
      <section
        class={
          isFullscreen
            ? 'sticky top-0 z-20 border-b border-base-300 bg-base-100 px-3 py-2'
            : 'sticky top-0 z-20 mb-1.5 rounded-box-half border border-base-300 bg-base-200 px-2 py-1.5'
        }
      >
        <div class="flex items-center gap-2">
          <label class="input input-bordered input-sm flex h-9 flex-1 items-center gap-2">
            <IconSearch size={18} class="opacity-70" />
            <input
              type="text"
              class="grow bg-transparent text-sm"
              value={searchQuery}
              placeholder={t(
                'Search with operators, phrases, and boolean logic: from:alice ("design system"~2 OR reliability)',
              )}
              onInput={(event) => setSearchQuery((event.target as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearchQuery('');
                }
              }}
            />
            {searchQuery ? (
              <button
                class="btn btn-ghost btn-xs"
                title={t('Clear search')}
                onClick={() => setSearchQuery('')}
              >
                <IconX size={14} />
              </button>
            ) : null}
          </label>
          {bookmarkFolderOptions?.length ? (
            <MultiSelect
              class="w-56"
              options={bookmarkFolderOptions}
              selected={selectedFolders}
              onChange={handleBookmarkFolderSelectionChange}
              placeholder={t('Bookmark folders')}
              selectedSummary={(count) =>
                count === 1 ? t('1 folder selected') : t('{{count}} folders selected', { count })
              }
            />
          ) : null}
          <button
            class="btn btn-ghost btn-sm"
            onClick={toggleShowSearchHelp}
            title={t('Search help')}
          >
            <IconInfoCircle size={18} />
          </button>
          {alternateViews?.length ? (
            <div class="join">
              <button
                class={`btn join-item btn-sm ${activeViewId === 'table' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setActiveViewId('table')}
                title={t('Table view')}
              >
                <IconTable size={16} />
              </button>
              {alternateViews.map((view) => {
                const viewBlocked =
                  sourceMode &&
                  totalCount > LARGE_ALTERNATE_VIEW_SOURCE_THRESHOLD &&
                  view.sourceBacked !== true &&
                  !normalizedSearchQuery;
                return (
                  <button
                    key={view.id}
                    class={`btn join-item btn-sm ${activeViewId === view.id ? 'btn-primary' : 'btn-ghost'} ${viewBlocked ? 'btn-disabled' : ''}`}
                    onClick={() => setActiveViewId(view.id)}
                    disabled={viewBlocked}
                    title={
                      viewBlocked
                        ? t('{{view}} is disabled for large source-backed result sets.', {
                            view: view.label,
                          })
                        : t(view.label as TranslationKey)
                    }
                  >
                    {view.icon === 'grid' ? <IconLayoutGrid size={16} /> : <IconTable size={16} />}
                  </button>
                );
              })}
            </div>
          ) : null}
          <button
            class="btn btn-ghost btn-sm"
            onClick={() => setIsFullscreen((current) => !current)}
            title={isFullscreen ? t('Exit fullscreen') : t('Fullscreen')}
          >
            {isFullscreen ? <IconArrowsMinimize size={18} /> : <IconArrowsMaximize size={18} />}
          </button>
        </div>
        {normalizedSearchQuery ? (
          <div class="mt-1.5 space-y-1 text-[10px] leading-4">
            {searchReadinessState.phase !== 'idle' ? (
              <div
                class={`font-mono ${
                  searchReadinessState.phase === 'degraded' ||
                  searchReadinessState.phase === 'failed'
                    ? 'text-warning'
                    : 'opacity-70'
                }`}
              >
                {searchReadinessState.label}
                {searchReadinessState.cancellable ? ' - cancellable on query change' : ''}
              </div>
            ) : null}
            {searchResult.parsed.lexicalExpression ? (
              <div class="font-mono opacity-70 break-all">
                parsed: {searchResult.parsed.lexicalExpression}
              </div>
            ) : null}
            {searchResult.warningObjects.length ? (
              <div class="rounded-box-half border border-warning/40 bg-warning/10 px-2 py-1 font-mono text-warning">
                {searchResult.warningObjects.map((warning, index) => (
                  <div key={`search-warning-${index}`}>
                    [{warning.code}] {warning.message}
                    {warning.token ? ` (${warning.token})` : ''}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div class="mt-1 flex min-w-0 items-center justify-between gap-3 overflow-hidden whitespace-nowrap text-[10px] leading-4 font-mono opacity-70">
          <span class="min-w-0 flex-1 truncate">
            {activeAlternateView
              ? alternateDiagnostics?.primary
                ? t('{{view}} view - {{status}}', {
                    view: t(activeAlternateView.label as TranslationKey),
                    status: alternateDiagnostics.primary,
                  })
                : t('{{view}} view', { view: t(activeAlternateView.label as TranslationKey) })
              : loading
                ? t('loading {{loaded}}/{{total}}', {
                    loaded: loadedCount,
                    total: Math.max(totalCount, records.length),
                  })
                : normalizedSearchQuery
                  ? searchPending
                    ? t('searching {{matches}}/{{total}}', {
                        matches: searchResult.totalMatches,
                        total: records.length,
                      })
                    : t('matches {{matches}}/{{total}}', {
                        matches: searchResult.totalMatches,
                        total: records.length,
                      })
                  : hasMore || totalCount > records.length
                    ? t('rows {{loaded}}/{{total}}', {
                        loaded: records.length,
                        total: Math.max(totalCount, records.length),
                      })
                    : t('rows {{count}}', { count: records.length })}
            {!activeAlternateView && !normalizedSearchQuery && loadingMore
              ? ` ${t('buffering...')}`
              : ''}
          </span>
          <div class="flex shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap">
            {activeAlternateView ? (
              <>
                {(alternateDiagnostics?.details ?? []).map((detail) => (
                  <span key={detail.key} class={diagnosticVisibilityClass(detail.minWidth)}>
                    {detail.label}
                  </span>
                ))}
                {alternateDiagnostics?.actions ? (
                  <span class="shrink-0">{alternateDiagnostics.actions}</span>
                ) : null}
              </>
            ) : (
              <>
                {searchHistoryScope ? (
                  <span class="hidden lg:inline">
                    {t('history {{count}}', { count: searchHistoryCount })}
                  </span>
                ) : null}
                <span class="hidden md:inline">
                  {t('selected {{count}} ({{mode}})', {
                    count: selectedResultCount,
                    mode: t(selectionMode as TranslationKey),
                  })}
                </span>
                {tableTelemetryActive ? (
                  <span class="hidden sm:inline">
                    {t('rendered {{rendered}}/{{total}} (window {{start}}-{{end}})', {
                      rendered: visibleRows.length,
                      total: totalRows,
                      start: visibleStartIndex + 1,
                      end: visibleEndIndex || 0,
                    })}
                  </span>
                ) : null}
              </>
            )}
          </div>
        </div>
      </section>

      {/* Data view. */}
      <main
        ref={scrollAreaRef}
        onScroll={onTableScroll}
        class="max-w-full min-h-0 grow overflow-y-auto overflow-x-auto bg-base-200 overscroll-none rounded-box-half border border-base-300"
      >
        {ActiveAlternateView && activeAlternateViewBlocked ? (
          <div class="flex h-[320px] flex-col items-center justify-center gap-3 px-4 text-center text-sm">
            <div class="max-w-md opacity-70">
              {activeAlternateView?.label} is available after narrowing the result set or switching
              back to table mode.
            </div>
            <button class="btn btn-sm btn-primary" onClick={() => setActiveViewId('table')}>
              <IconTable size={16} />
              Table
            </button>
          </div>
        ) : ActiveAlternateView ? (
          <ActiveAlternateView
            records={sortedRecords}
            scrollParentRef={scrollAreaRef}
            storageKey={`${resolvedViewStateKey}:${activeAlternateView?.id || 'table'}`}
            fullscreen={isFullscreen}
            sourceMode={sourceMode}
            sourceTotalCount={totalCount}
            streamSourceRows={streamSourceRows}
            mediaSourceKey={mediaSourceKey}
            mediaSourceTotalCount={mediaSourceTotalCount}
            getMediaWindow={getMediaWindow}
            streamMediaRows={streamMediaRows}
            onDiagnosticsChange={handleAlternateDiagnosticsChange}
            onOpenMedia={(url) => {
              setMediaPreview(url);
              setShowMediaModal(true);
            }}
          />
        ) : (
          <>
            <table
              class="table table-fixed table-pin-rows table-border-bc table-padding-sm"
              style={{ width: `max(${stableTableWidth}px, 100%)` }}
            >
              <colgroup>
                {visibleLeafColumns.map((column) => (
                  <col key={column.id} style={{ width: `${column.getSize()}px` }} />
                ))}
              </colgroup>
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        className={header.column.getCanSort() ? 'cursor-pointer select-none' : ''}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() === 'asc' && (
                          <IconSortAscending size={15} class="inline align-top ml-1" />
                        )}
                        {header.column.getIsSorted() === 'desc' && (
                          <IconSortDescending size={15} class="inline align-top ml-1" />
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody ref={tbodyRef}>
                {topSpacerHeight > 0 ? (
                  <tr aria-hidden="true">
                    <td
                      colSpan={Math.max(1, table.getVisibleFlatColumns().length)}
                      style={{ height: `${topSpacerHeight}px`, padding: 0, border: 0 }}
                    />
                  </tr>
                ) : null}
                {visibleRows.map((row, index) => (
                  <tr
                    key={row.id}
                    data-vrow="1"
                    data-vrow-key={
                      rowKeys[
                        sourceBrowsingActive
                          ? Math.max(0, visibleStartIndex - sourceWindowStartIndex) + index
                          : visibleStartIndex + index
                      ] || row.id
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
                {bottomSpacerHeight > 0 ? (
                  <tr aria-hidden="true">
                    <td
                      colSpan={Math.max(1, table.getVisibleFlatColumns().length)}
                      style={{ height: `${bottomSpacerHeight}px`, padding: 0, border: 0 }}
                    />
                  </tr>
                ) : null}
              </tbody>
            </table>

            {/* Empty view. */}
            {visibleRecords.length > 0 ? null : (
              <div class="flex items-center justify-center h-[320px] w-full">
                <p class="text-base-content text-opacity-50">{t('No data available.')}</p>
              </div>
            )}
          </>
        )}
      </main>

      {/* Action buttons. */}
      <div class="flex mt-1.5 items-center gap-2 border-t border-base-300 px-2 py-1.5">
        {showClearButton ? (
          <button class="btn btn-sm btn-neutral btn-ghost" onClick={clear}>
            {t('Clear')}
          </button>
        ) : null}
        <span class="flex-grow" />
        {renderActions?.(table, {
          loading,
          loadingMore,
          loadedCount,
          totalCount,
          resultRecords: sourceBrowsingActive ? visibleRecords : sortedRecords,
          visibleRecords,
        })}
        <button
          class="btn btn-sm btn-primary"
          onClick={openExportDataModal}
          disabled={loading}
          title={
            preparingExport
              ? t('Export menu is open while remaining rows load in the background.')
              : loading
                ? t('Wait for records to finish loading before exporting.')
                : sourceBrowsingActive && streamSourceRows
                  ? t(
                      'Exports stream from the active source without loading all rows into the table.',
                    )
                  : hasMore && !normalizedSearchQuery
                    ? t('Opens immediately and loads remaining rows in the background.')
                    : undefined
          }
        >
          {preparingExport ? <span class="loading loading-spinner" /> : null}
          {t('Export Data')}
        </button>
      </div>

      {/* Media preview widget. */}
      {mediaPreview && !showMediaModal ? (
        <aside class="absolute right-2 bottom-14 z-[2] w-56 rounded-box-half border border-base-300 bg-base-100 shadow-lg">
          <header class="flex items-center justify-between border-b border-base-300 px-2 py-1 text-xs font-semibold">
            <span>{t('Media View')}</span>
            <div class="flex items-center gap-1">
              <button class="btn btn-ghost btn-xs" onClick={() => setShowMediaModal(true)}>
                Open
              </button>
              <button class="btn btn-ghost btn-xs" onClick={() => setMediaPreview('')}>
                <IconX size={12} />
              </button>
            </div>
          </header>
          <div class="h-36 overflow-hidden bg-base-200">
            {mediaPreview.includes('.mp4') ? (
              <video controls class="h-full w-full object-contain" src={mediaPreview} />
            ) : (
              <img class="h-full w-full object-contain" src={mediaPreview} />
            )}
          </div>
        </aside>
      ) : null}

      {/* Extra modal for previewing JSON data. */}
      <Modal
        title={t('JSON View')}
        class="max-w-xl"
        show={!!rawDataPreview}
        onClose={() => setRawDataPreview(null)}
      >
        <main class="max-w-full max-h-[500px] overflow-scroll overscroll-none">
          {typeof rawDataPreview === 'string' ? (
            <p class="whitespace-pre-wrap">{rawDataPreview}</p>
          ) : (
            <pre class="text-xs leading-none">{JSON.stringify(rawDataPreview, null, 2)}</pre>
          )}
        </main>
      </Modal>

      {/* Extra modal for previewing images and videos. */}
      <Modal
        title={t('Media View')}
        class="max-w-xl"
        show={showMediaModal && !!mediaPreview}
        onClose={() => setShowMediaModal(false)}
      >
        <main class="max-w-full">
          {mediaPreview.includes('.mp4') ? (
            <video controls class="w-full max-h-[400px] object-contain" src={mediaPreview} />
          ) : (
            <img class="w-full max-h-[400px] object-contain" src={mediaPreview} />
          )}
        </main>
      </Modal>

      {/* Search help modal. */}
      <Modal
        title={t('Search Operators')}
        class="max-w-2xl max-h-[calc(100vh-2rem)] overflow-hidden"
        show={showSearchHelp}
        onClose={toggleShowSearchHelp}
      >
        <div class="min-h-0 grow overflow-y-auto pr-1 text-sm leading-6">
          <p class="mb-2">
            {t('Query semantics now follow recorder-style precedence:')}{' '}
            <code class="ml-1">NOT</code>,<code class="ml-1">AND</code>,<code class="ml-1">OR</code>
            , {t('with implicit')} <code class="ml-1">AND</code> {t('between adjacent terms.')}
          </p>
          <div class="grid gap-3 md:grid-cols-2">
            {operatorHelpGroups.map(([category, entries]) => (
              <section
                key={category}
                class="rounded-box-half border border-base-300 bg-base-200/70 p-3"
              >
                <h4 class="mb-2 text-xs font-semibold uppercase tracking-[0.08em] opacity-70">
                  {t(`search.category.${category}` as TranslationKey)}
                </h4>
                <div class="space-y-2">
                  {entries.map((entry) => (
                    <div key={`${category}-${entry.syntax}`} class="text-xs">
                      <div class="font-mono text-[11px] text-info">{entry.syntax}</div>
                      <div>{t(entry.description as TranslationKey)}</div>
                      <div class="font-mono opacity-70">{entry.examples.join(' | ')}</div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </Modal>

      {/* Extra modal for exporting JSON data. */}
      <ExportDataModal
        title={title}
        columns={columns}
        resultRecords={sourceBrowsingActive ? visibleRecords : sortedRecords}
        resultCount={sourceBrowsingActive ? totalRows : sortedRecords.length}
        streamResultRecords={sourceBrowsingActive ? streamSourceRows : streamSearchResultRows}
        selectedRecords={selectedRecords}
        selectedRecordCount={selectionMode === 'explicit' ? selectedRecordIds.length : undefined}
        streamSelectedRecords={streamSelectedSourceRows}
        selectionExcludedRecordIds={selectionExcludedRecordIds}
        resultSetSnapshot={resultSetSnapshot}
        selectionMode={selectionMode}
        preparingFullDataset={preparingExport}
        show={showExportDataModal}
        onClose={toggleShowExportDataModal}
      />

      {/* Extra contents. */}
      {renderExtra?.(table, {
        resultSetSnapshot,
        resultRecords: sourceBrowsingActive ? visibleRecords : sortedRecords,
        selectedRecords,
        selectionMode,
        selectionExcludedRecordIds,
      })}
    </div>
  );
}
