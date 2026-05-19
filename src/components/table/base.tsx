import { ComponentType, JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { Modal, MultiSelect } from '@/components/common';
import { useTranslation } from '@/i18n';
import { extractStableRecordId, ResultSetSnapshot } from '@/utils/result-set';
import { SEARCH_OPERATOR_HELP_ENTRIES } from '@/utils/search-query';
import { appendSearchHistoryEntry, readSearchHistory } from '@/utils/search-history';
import { useSignalState, useToggle } from '@/utils/common';
import { nowMs, recordPerfMetric } from '@/core/perf/metrics';
import type { SearchDocumentRow } from '@/core/database/manager';
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
import {
  ColumnDef,
  getCoreRowModel,
  RowSelectionState,
  Row,
  RowData,
  Table,
} from '@tanstack/table-core';

import { ExportDataModal } from '../modals/export-data';
import { useResultSetController } from './use-result-set-controller';

const VIRTUAL_OVERSCAN_ROWS = 12;
const VIRTUAL_INITIAL_ROW_HEIGHT = 74;
const VIEWER_PREFETCH_VIEWPORTS = 4;
const VIRTUAL_OVERSCAN_PX = 1600;
const VIRTUAL_MAX_WINDOW_ROWS = 90;
const VIRTUAL_SCROLL_UPDATE_PX = 24;
const HIGHLIGHT_ATTRIBUTE = 'data-twe-highlight-v1';

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
  loadMore?: () => Promise<void>;
  loadAll?: () => Promise<void>;
  hydrateRecordsByIds?: (ids: string[]) => Promise<T[]>;
  records: T[];
  searchDocuments?: SearchDocumentRow[];
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
};

export type BaseTableAlternateViewProps<T> = {
  records: T[];
  scrollParentRef: { current: HTMLElement | null };
  onOpenMedia: (url: string) => void;
  storageKey?: string;
  fullscreen?: boolean;
};

export type BaseTableAlternateView<T> = {
  id: string;
  label: string;
  icon: 'table' | 'grid';
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
  const highlighted = root.querySelectorAll(`mark[${HIGHLIGHT_ATTRIBUTE}="1"]`);
  highlighted.forEach((node) => {
    if (node instanceof HTMLElement) {
      unwrapHighlightMark(node);
    }
  });
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

  for (const node of textNodes) {
    const text = node.nodeValue || '';
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;

    const fragment = document.createDocumentFragment();
    let cursor = 0;

    text.replace(pattern, (match: string, _capture: string, index: number) => {
      if (index > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
      }
      const mark = document.createElement('mark');
      mark.setAttribute(HIGHLIGHT_ATTRIBUTE, '1');
      mark.className = 'bg-warning/30 text-inherit rounded-[2px] px-[1px]';
      mark.textContent = match;
      fragment.appendChild(mark);
      cursor = index + match.length;
      return match;
    });

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    node.parentNode?.replaceChild(fragment, node);
  }
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
  loadMore,
  loadAll,
  hydrateRecordsByIds,
  records,
  searchDocuments,
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
    sorting,
    setSorting,
    selectionMode,
    isFullscreen,
    setIsFullscreen,
    activeViewId,
    setActiveViewId,
    searchResult,
    searchPending,
    sortedRecords,
    currentResultIds,
    handleRowSelectionChange,
    selectedRecords,
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
    hydrateRecordsByIds,
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

  // Infinite scrolling batch renderer.
  const scrollAreaRef = useRef<HTMLElement | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const scrollTopRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);
  const rowHeightsRef = useRef(new Map<string, number>());
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
  const totalRows = sortedRecords.length;
  const rowKeys = currentResultIds;
  const virtualOffsets = useMemo(() => {
    const offsets = new Array<number>(totalRows + 1);
    offsets[0] = 0;
    for (let index = 0; index < totalRows; index += 1) {
      const key = rowKeys[index] || `row-${index}`;
      const height = rowHeightsRef.current.get(key) || safeRowHeight;
      offsets[index + 1] = (offsets[index] || 0) + Math.max(24, height);
    }
    return offsets;
  }, [rowHeightsVersion, rowKeys, safeRowHeight, totalRows]);
  const totalVirtualHeight = virtualOffsets[totalRows] || 0;
  const startIndex = Math.max(
    0,
    findVirtualIndexForOffset(virtualOffsets, virtualScrollTop - VIRTUAL_OVERSCAN_PX) -
      VIRTUAL_OVERSCAN_ROWS,
  );
  const requestedEndIndex =
    findVirtualIndexForOffset(
      virtualOffsets,
      virtualScrollTop + viewportHeight + VIRTUAL_OVERSCAN_PX,
    ) +
    VIRTUAL_OVERSCAN_ROWS +
    1;
  const endIndex = Math.min(
    totalRows,
    Math.max(startIndex + 1, Math.min(requestedEndIndex, startIndex + VIRTUAL_MAX_WINDOW_ROWS)),
  );
  const visibleRecords = useMemo(
    () => sortedRecords.slice(startIndex, endIndex),
    [sortedRecords, startIndex, endIndex],
  );

  useEffect(() => {
    if (!hasMore || loading || loadingMore || activeAlternateView || normalizedSearchQuery) {
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

  const topSpacerHeight = virtualOffsets[startIndex] || 0;
  const bottomSpacerHeight = Math.max(
    0,
    totalVirtualHeight - (virtualOffsets[endIndex] || totalVirtualHeight),
  );

  const toggleResultRowSelected = (rowId: string) => {
    if (selectionMode === 'all') {
      handleRowSelectionChange(() => {
        const next: RowSelectionState = {};
        currentResultIds.forEach((id) => {
          if (id !== rowId) {
            next[id] = true;
          }
        });
        return next;
      });
      return;
    }
    handleRowSelectionChange((current) => ({
      ...current,
      [rowId]: !current[rowId],
    }));
  };

  const toggleAllResultRowsSelected = () => {
    const shouldSelectAll =
      selectionMode !== 'all' || currentResultIds.some((id) => !rowSelection[id]);
    handleRowSelectionChange(() => {
      if (!shouldSelectAll) {
        return {};
      }
      if (selectionMode === 'all') {
        return rowSelection;
      }
      const next: RowSelectionState = {};
      currentResultIds.forEach((id) => {
        next[id] = true;
      });
      return next;
    });
  };

  const table = useReactTable<T>({
    data: visibleRecords,
    columns,
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (record, index) => extractStableRecordId(record, startIndex + index),
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
        currentResultIds.length > 0 &&
        (selectionMode === 'all' || currentResultIds.every((id) => !!rowSelection[id])),
      isSomeResultRowsSelected: () =>
        selectionMode === 'all' ? false : currentResultIds.some((id) => !!rowSelection[id]),
      toggleAllResultRowsSelected,
      isResultRowSelected: (rowId) => (selectionMode === 'all' ? true : !!rowSelection[rowId]),
      toggleResultRowSelected,
    },
  });
  const visibleRows = table.getRowModel().rows;

  useEffect(() => {
    if (firstRowsReportedRef.current || !visibleRows.length) return;
    firstRowsReportedRef.current = true;
    recordPerfMetric({
      kind: 'viewer',
      name: 'first-visible-rows',
      durationMs: nowMs() - openedAtRef.current,
      tags: {
        title,
        records: records.length,
        visibleRows: visibleRows.length,
        loading,
      },
    });
  }, [loading, records.length, title, visibleRows.length]);

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
          if (!previous || Math.abs(previous - measuredHeight) > 2) {
            rowHeightsRef.current.set(key, measuredHeight);
            changed = true;
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
    }
  }, [endIndex, normalizedSearchQuery, selectedFolders, startIndex, visibleRows]);

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
    ? 'relative flex h-full min-h-0 flex-col overflow-hidden bg-base-100 text-base-content'
    : 'relative flex h-full min-h-0 flex-col';

  const ActiveAlternateView = activeAlternateView?.component;

  return (
    <div class={rootClass}>
      <section
        class={
          isFullscreen
            ? 'border-b border-base-300 bg-base-100 px-3 py-2'
            : 'mb-1.5 rounded-box-half border border-base-300 bg-base-200 px-2 py-1.5'
        }
      >
        <div class="flex items-center gap-2">
          <label class="input input-bordered input-sm flex h-9 flex-1 items-center gap-2">
            <IconSearch size={18} class="opacity-70" />
            <input
              type="text"
              class="grow bg-transparent text-sm"
              value={searchQuery}
              placeholder='Search with operators, phrases, and boolean logic: from:alice ("design system"~2 OR reliability)'
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
                title="Clear search"
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
              onChange={setSelectedFolders}
              placeholder={t('Bookmark folders')}
              selectedSummary={(count) =>
                count === 1 ? t('1 folder selected') : t('{{count}} folders selected', { count })
              }
            />
          ) : null}
          <button class="btn btn-ghost btn-sm" onClick={toggleShowSearchHelp} title="Search help">
            <IconInfoCircle size={18} />
          </button>
          {alternateViews?.length ? (
            <div class="join">
              <button
                class={`btn join-item btn-sm ${activeViewId === 'table' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setActiveViewId('table')}
                title="Table view"
              >
                <IconTable size={16} />
              </button>
              {alternateViews.map((view) => (
                <button
                  key={view.id}
                  class={`btn join-item btn-sm ${activeViewId === view.id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActiveViewId(view.id)}
                  title={view.label}
                >
                  {view.icon === 'grid' ? <IconLayoutGrid size={16} /> : <IconTable size={16} />}
                </button>
              ))}
            </div>
          ) : null}
          <button
            class="btn btn-ghost btn-sm"
            onClick={() => setIsFullscreen((current) => !current)}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <IconArrowsMinimize size={18} /> : <IconArrowsMaximize size={18} />}
          </button>
        </div>
        {normalizedSearchQuery ? (
          <div class="mt-1.5 space-y-1 text-[10px] leading-4">
            {searchPending ? (
              <div class="font-mono opacity-70">searching local index...</div>
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
        <div class="mt-1 flex items-center justify-between text-[10px] leading-4 font-mono opacity-70">
          <span>
            {loading
              ? `loading ${loadedCount}/${Math.max(totalCount, records.length)}`
              : normalizedSearchQuery
                ? `${searchPending ? 'searching' : 'matches'} ${searchResult.totalMatches}/${records.length}`
                : hasMore || totalCount > records.length
                  ? `rows ${records.length}/${Math.max(totalCount, records.length)}`
                  : `rows ${records.length}`}
            {!normalizedSearchQuery && loadingMore ? ' buffering...' : ''}
          </span>
          <div class="flex items-center gap-3">
            {searchHistoryScope ? <span>history {searchHistoryCount}</span> : null}
            <span>
              selected {selectedRecords.length} ({selectionMode})
            </span>
            <span>
              rendered {visibleRows.length}/{sortedRecords.length} (window {startIndex + 1}-
              {endIndex || 0})
            </span>
          </div>
        </div>
      </section>

      {/* Data view. */}
      <main
        ref={scrollAreaRef}
        onScroll={onTableScroll}
        class="max-w-full grow overflow-y-auto overflow-x-auto bg-base-200 overscroll-none rounded-box-half border border-base-300"
      >
        {ActiveAlternateView ? (
          <ActiveAlternateView
            records={sortedRecords}
            scrollParentRef={scrollAreaRef}
            storageKey={`${resolvedViewStateKey}:${activeAlternateView?.id || 'table'}`}
            fullscreen={isFullscreen}
            onOpenMedia={(url) => {
              setMediaPreview(url);
              setShowMediaModal(true);
            }}
          />
        ) : (
          <>
            <table class="table table-pin-rows table-border-bc table-padding-sm">
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
                    data-vrow-key={rowKeys[startIndex + index] || row.id}
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
            {sortedRecords.length > 0 ? null : (
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
          resultRecords: sortedRecords,
          visibleRecords,
        })}
        <button
          class="btn btn-sm btn-primary"
          onClick={openExportDataModal}
          disabled={loading}
          title={
            preparingExport
              ? 'Export menu is open while remaining rows load in the background.'
              : loading
                ? 'Wait for records to finish loading before exporting.'
                : hasMore && !normalizedSearchQuery
                  ? 'Opens immediately and loads remaining rows in the background.'
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
        title="Search Operators"
        class="max-w-2xl"
        show={showSearchHelp}
        onClose={toggleShowSearchHelp}
      >
        <div class="text-sm leading-6">
          <p class="mb-2">
            Query semantics now follow recorder-style precedence:
            <code class="ml-1">NOT</code>,<code class="ml-1">AND</code>,<code class="ml-1">OR</code>
            , with implicit
            <code class="ml-1">AND</code> between adjacent terms.
          </p>
          <div class="grid gap-3 md:grid-cols-2">
            {operatorHelpGroups.map(([category, entries]) => (
              <section
                key={category}
                class="rounded-box-half border border-base-300 bg-base-200/70 p-3"
              >
                <h4 class="mb-2 text-xs font-semibold uppercase tracking-[0.08em] opacity-70">
                  {category.replace('_', ' ')}
                </h4>
                <div class="space-y-2">
                  {entries.map((entry) => (
                    <div key={`${category}-${entry.syntax}`} class="text-xs">
                      <div class="font-mono text-[11px] text-info">{entry.syntax}</div>
                      <div>{entry.description}</div>
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
        resultRecords={sortedRecords}
        selectedRecords={selectedRecords}
        resultSetSnapshot={resultSetSnapshot}
        selectionMode={selectionMode}
        preparingFullDataset={preparingExport}
        show={showExportDataModal}
        onClose={toggleShowExportDataModal}
      />

      {/* Extra contents. */}
      {renderExtra?.(table, {
        resultSetSnapshot,
        resultRecords: sortedRecords,
        selectedRecords,
        selectionMode,
      })}
    </div>
  );
}
