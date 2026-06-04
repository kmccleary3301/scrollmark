import { ExportMediaModal } from '@/components/modals/export-media';
import { db } from '@/core/database';
import {
  useClearCaptures,
  useDbBackedCapturedRecords,
  useDbBackedFolderRecords,
  useDbBackedMediaRecords,
  useSearchDocumentFolderFacets,
  useSearchDocuments,
} from '@/core/database/hooks';
import { Extension, ExtensionType } from '@/core/extensions';
import { useTranslation } from '@/i18n';
import { Tweet, User } from '@/types';
import { useToggle } from '@/utils/common';
import { downloadJson } from '@/modules/runtime-logs/diagnostics-bundle';
import { readSearchHistory } from '@/utils/search-history';
import { ColumnDef } from '@tanstack/table-core';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { BaseTableView } from './base';
import { columns as columnsTweet } from './columns-tweet';
import { columns as columnsUser } from './columns-user';
import { TweetMediaMasonry } from './tweet-media-masonry';

type TableViewProps = {
  title: string;
  extension: Extension;
  fullscreen?: boolean;
  onFullscreenChange?: (value: boolean) => void;
};

async function* emptyTweetStream(): AsyncIterable<Tweet> {}

type BookmarkFolderStatus = 'api-name' | 'id-only' | 'none';

function getBookmarkFolderStatus(record: unknown): BookmarkFolderStatus {
  const obj = record as Record<string, unknown>;
  const folderName = obj?.__bookmark_folder_name;
  const folderNameSource = obj?.__bookmark_folder_name_source;
  const folderId = obj?.__bookmark_folder_id;

  if (
    folderNameSource === 'api' &&
    typeof folderName === 'string' &&
    folderName.trim().length > 0
  ) {
    return 'api-name';
  }
  if (typeof folderId === 'string' && folderId.trim().length > 0) {
    return 'id-only';
  }
  return 'none';
}

function useBookmarkFolderUiState(args: {
  isBookmarksModule: boolean;
  records: Array<Tweet | User>;
  summary: ReturnType<typeof useSearchDocumentFolderFacets>['summary'];
}) {
  const { isBookmarksModule, records, summary } = args;
  const [bookmarkStatus, setBookmarkStatus] = useState<{
    latestStatus: BookmarkFolderStatus;
    counts: Record<BookmarkFolderStatus, number>;
  }>({
    latestStatus: 'none',
    counts: {
      'api-name': 0,
      'id-only': 0,
      none: 0,
    },
  });
  const [bookmarkFolderOptions, setBookmarkFolderOptions] = useState<
    Array<{ label: string; value: string }>
  >([]);

  useEffect(() => {
    if (!isBookmarksModule) {
      setBookmarkStatus({
        latestStatus: 'none',
        counts: {
          'api-name': 0,
          'id-only': 0,
          none: 0,
        },
      });
      setBookmarkFolderOptions([]);
      return;
    }

    let cancelled = false;
    let idleHandle = 0;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null = null;

    const recompute = () => {
      if (cancelled) return;
      const items = (records ?? []) as unknown[];
      const counts: Record<BookmarkFolderStatus, number> = {
        'api-name': 0,
        'id-only': 0,
        none: 0,
      };
      const counter = new Map<string, { label: string; count: number }>();

      if (summary) {
        counts['api-name'] = summary.statusCounts['api-name'];
        counts['id-only'] = summary.statusCounts['id-only'];
        counts.none = summary.statusCounts.none;
        for (const facet of summary.facets) {
          counter.set(facet.folderId, {
            label: facet.label,
            count: facet.count,
          });
        }
      } else {
        for (const item of items) {
          counts[getBookmarkFolderStatus(item)]++;
          if (!item || typeof item !== 'object') continue;
          const row = item as Record<string, unknown>;
          const folderId =
            typeof row.__bookmark_folder_id === 'string' ? row.__bookmark_folder_id : '';
          if (!folderId.trim()) continue;
          const folderName =
            row.__bookmark_folder_name_source === 'api' &&
            typeof row.__bookmark_folder_name === 'string'
              ? row.__bookmark_folder_name.trim()
              : '';

          const current = counter.get(folderId);
          if (current) {
            current.count += 1;
          } else {
            counter.set(folderId, {
              label: folderName ? `${folderName}` : `Folder ${folderId}`,
              count: 1,
            });
          }
        }
      }

      setBookmarkStatus({
        latestStatus: summary
          ? counts['api-name'] > 0
            ? 'api-name'
            : counts['id-only'] > 0
              ? 'id-only'
              : 'none'
          : items.length > 0
            ? getBookmarkFolderStatus(items[items.length - 1])
            : ('none' as const),
        counts,
      });
      setBookmarkFolderOptions(
        [...counter.entries()]
          .sort((a, b) => {
            if (b[1].count !== a[1].count) return b[1].count - a[1].count;
            return a[1].label.localeCompare(b[1].label);
          })
          .map(([value, meta]) => ({
            value,
            label: `${meta.label} (${meta.count})`,
          })),
      );
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      idleHandle = (
        window as Window & {
          requestIdleCallback: (callback: IdleRequestCallback) => number;
        }
      ).requestIdleCallback(() => recompute());
    } else {
      timeoutHandle = globalThis.setTimeout(recompute, 80);
    }

    return () => {
      cancelled = true;
      if (idleHandle && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
        (
          window as Window & {
            cancelIdleCallback: (handle: number) => void;
          }
        ).cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) {
        globalThis.clearTimeout(timeoutHandle);
      }
    };
  }, [isBookmarksModule, records, summary]);

  return { bookmarkStatus, bookmarkFolderOptions };
}

export function TableView({ title, extension, fullscreen, onFullscreenChange }: TableViewProps) {
  return (
    <SourceBackedTableView
      title={title}
      extension={extension}
      fullscreen={fullscreen}
      onFullscreenChange={onFullscreenChange}
    />
  );
}

/**
 * Common table view.
 */
function SourceBackedTableView({
  title,
  extension,
  fullscreen,
  onFullscreenChange,
}: TableViewProps) {
  const { t } = useTranslation();

  // Query records from the database.
  const { name, type } = extension;
  const capturedState = useDbBackedCapturedRecords(name, type);
  const searchDocumentsState = useSearchDocuments(name, type, false);
  const folderFacetsState = useSearchDocumentFolderFacets(
    name,
    type,
    name === 'BookmarksModule' && type === ExtensionType.TWEET,
  );
  const clearCapturedData = useClearCaptures(name);
  const isBookmarksModule = name === 'BookmarksModule' && type === ExtensionType.TWEET;
  const [sourceBackedFolderIds, setSourceBackedFolderIds] = useState<string[]>([]);
  const sourceBackedFolderScope =
    isBookmarksModule && sourceBackedFolderIds.length > 0 ? sourceBackedFolderIds : undefined;
  const sourceBackedFolderTotalCount = useMemo(() => {
    if (!sourceBackedFolderScope?.length || !folderFacetsState.summary) return undefined;
    const countByFolder = new Map(
      folderFacetsState.summary.facets.map((facet) => [facet.folderId, facet.count]),
    );
    return sourceBackedFolderScope.reduce(
      (sum, folderId) => sum + (Number(countByFolder.get(folderId)) || 0),
      0,
    );
  }, [folderFacetsState.summary, sourceBackedFolderScope]);
  const folderState = useDbBackedFolderRecords(
    name,
    type,
    sourceBackedFolderScope,
    Boolean(sourceBackedFolderScope?.length),
    sourceBackedFolderTotalCount,
  );
  const mediaState = useDbBackedMediaRecords(
    name,
    sourceBackedFolderScope,
    type === ExtensionType.TWEET,
  );
  const activeCapturedState = folderState.active ? folderState : capturedState;
  const records = activeCapturedState.records;
  const { bookmarkStatus, bookmarkFolderOptions } = useBookmarkFolderUiState({
    isBookmarksModule,
    records,
    summary: folderFacetsState.summary,
  });

  // Control modal visibility for exporting media.
  const [showExportMediaModal, toggleShowExportMediaModal] = useToggle();

  const tweetAlternateViews = [
    {
      id: 'media-masonry',
      label: 'Media masonry',
      icon: 'grid' as const,
      sourceBacked: true,
      component: TweetMediaMasonry,
    },
  ];

  const renderActions = (
    _table: unknown,
    context: {
      loading: boolean;
      loadingMore: boolean;
      loadedCount: number;
      totalCount: number;
      resultRecords: Tweet[] | User[];
      visibleRecords: Tweet[] | User[];
    },
  ) => {
    const mediaExportBlocked =
      isBookmarksModule &&
      context.totalCount > 10_000 &&
      context.resultRecords.length < context.totalCount &&
      !mediaState;
    return (
      <div class="flex items-center gap-2">
        {context.loading ? (
          <span class="font-mono text-[10px] opacity-60">
            loading {context.loadedCount}/{context.totalCount}
          </span>
        ) : null}
        {context.loadingMore ? (
          <span class="font-mono text-[10px] opacity-60">
            loading more {context.loadedCount}/{context.totalCount}
          </span>
        ) : null}
        {isBookmarksModule && (
          <button
            class="btn btn-sm btn-accent btn-outline"
            onClick={() => {
              const history = readSearchHistory('bookmarks');
              downloadJson(
                {
                  exported_at_ms: Date.now(),
                  exported_at_iso: new Date().toISOString(),
                  scope: 'bookmarks',
                  count: history.length,
                  history,
                },
                `twe-bookmarks-search-history-${Date.now()}.json`,
              );
            }}
            title="Export persisted bookmark search history"
          >
            {t('Export Search History')}
          </button>
        )}
        {isBookmarksModule && (
          <span
            class="badge badge-outline badge-sm font-mono tooltip before:whitespace-pre-line before:max-w-40"
            data-tip={`latest: ${bookmarkStatus.latestStatus}
api-name: ${bookmarkStatus.counts['api-name']}
id-only: ${bookmarkStatus.counts['id-only']}
none: ${bookmarkStatus.counts.none}`}
          >
            folder metadata: {bookmarkStatus.latestStatus}
          </span>
        )}
        <button
          class="btn btn-sm btn-secondary"
          onClick={toggleShowExportMediaModal}
          disabled={context.loading || mediaExportBlocked}
          title={
            context.loading
              ? 'Wait for records to finish loading before exporting.'
              : mediaExportBlocked
                ? 'Media export is disabled for large result sets until media export has a source-backed stream.'
                : undefined
          }
        >
          {t('Export Media')}
        </button>
      </div>
    );
  };

  if (type === ExtensionType.TWEET) {
    return (
      <BaseTableView<Tweet>
        title={title}
        viewStateKey={`${name}:${type}`}
        searchHistoryScope={isBookmarksModule ? 'bookmarks' : undefined}
        fullscreen={fullscreen}
        onFullscreenChange={onFullscreenChange}
        loading={activeCapturedState.loading}
        loadingMore={activeCapturedState.loadingWindow}
        loadedCount={activeCapturedState.loadedCount}
        totalCount={activeCapturedState.totalCount}
        hasMore={activeCapturedState.hasMore}
        sourceMode
        sourceModeFiltersActive={folderState.active}
        sourceWindowStartIndex={activeCapturedState.windowStartIndex}
        resultSourceDescriptor={activeCapturedState.sourceDescriptor}
        resultEntityType="tweet"
        onSourceWindowChange={activeCapturedState.requestWindow}
        streamSourceRows={() => activeCapturedState.streamRows() as AsyncIterable<Tweet>}
        streamMediaRows={() => mediaState?.streamRows() ?? emptyTweetStream()}
        mediaSourceTotalCount={mediaState?.totalCount ?? undefined}
        onBookmarkFolderSelectionChange={setSourceBackedFolderIds}
        hydrateRecordsByIds={(ids) => db.extGetTweetsByIds(ids) as Promise<Tweet[]>}
        records={(records as Tweet[]) ?? []}
        searchDocuments={searchDocumentsState.documents}
        searchDocumentsLoading={searchDocumentsState.loading}
        searchDocumentsLoaded={searchDocumentsState.loaded}
        searchDocumentTotalCount={searchDocumentsState.totalCount}
        searchDocumentsBlockedReason={searchDocumentsState.blockedReason}
        loadSearchDocuments={searchDocumentsState.load}
        loadSearchDocumentChunks={searchDocumentsState.loadChunks}
        columns={columnsTweet as ColumnDef<Tweet>[]}
        clear={clearCapturedData}
        alternateViews={tweetAlternateViews}
        bookmarkFolderOptions={bookmarkFolderOptions}
        renderActions={renderActions}
        renderExtra={(_table, context) => (
          <ExportMediaModal
            title={title}
            resultRecords={context.resultRecords}
            selectedRecords={context.selectedRecords}
            streamResultMediaRows={() => mediaState?.streamRows() ?? emptyTweetStream()}
            resultMediaSourceCount={mediaState?.totalCount ?? undefined}
            selectionExcludedRecordIds={context.selectionExcludedRecordIds}
            resultSetSnapshot={context.resultSetSnapshot}
            selectionMode={context.selectionMode}
            isTweet
            show={showExportMediaModal}
            onClose={toggleShowExportMediaModal}
          />
        )}
      />
    );
  }

  return (
    <BaseTableView<User>
      title={title}
      viewStateKey={`${name}:${type}`}
      searchHistoryScope={isBookmarksModule ? 'bookmarks' : undefined}
      fullscreen={fullscreen}
      onFullscreenChange={onFullscreenChange}
      loading={activeCapturedState.loading}
      loadingMore={activeCapturedState.loadingWindow}
      loadedCount={activeCapturedState.loadedCount}
      totalCount={activeCapturedState.totalCount}
      hasMore={activeCapturedState.hasMore}
      sourceMode
      sourceModeFiltersActive={folderState.active}
      sourceWindowStartIndex={activeCapturedState.windowStartIndex}
      resultSourceDescriptor={activeCapturedState.sourceDescriptor}
      resultEntityType="user"
      onSourceWindowChange={activeCapturedState.requestWindow}
      streamSourceRows={() => activeCapturedState.streamRows() as AsyncIterable<User>}
      onBookmarkFolderSelectionChange={setSourceBackedFolderIds}
      hydrateRecordsByIds={(ids) => db.extGetUsersByIds(ids) as Promise<User[]>}
      records={(records as User[]) ?? []}
      searchDocuments={searchDocumentsState.documents}
      searchDocumentsLoading={searchDocumentsState.loading}
      searchDocumentsLoaded={searchDocumentsState.loaded}
      searchDocumentTotalCount={searchDocumentsState.totalCount}
      searchDocumentsBlockedReason={searchDocumentsState.blockedReason}
      loadSearchDocuments={searchDocumentsState.load}
      loadSearchDocumentChunks={searchDocumentsState.loadChunks}
      columns={columnsUser as ColumnDef<User>[]}
      clear={clearCapturedData}
      bookmarkFolderOptions={bookmarkFolderOptions}
      renderActions={renderActions}
      renderExtra={(_table, context) => (
        <ExportMediaModal
          title={title}
          resultRecords={context.resultRecords}
          selectedRecords={context.selectedRecords}
          selectionExcludedRecordIds={context.selectionExcludedRecordIds}
          resultSetSnapshot={context.resultSetSnapshot}
          selectionMode={context.selectionMode}
          isTweet={false}
          show={showExportMediaModal}
          onClose={toggleShowExportMediaModal}
        />
      )}
    />
  );
}
