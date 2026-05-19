import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ColumnDef } from '@tanstack/table-core';
import { IconDatabaseImport, IconRefresh, IconTrash } from '@tabler/icons-preact';

import { ExtensionPanel, Modal } from '@/components/common';
import { BaseTableView } from '@/components/table/base';
import { columns as columnsTweet } from '@/components/table/columns-tweet';
import { columns as columnsUser } from '@/components/table/columns-user';
import { TweetMediaMasonry } from '@/components/table/tweet-media-masonry';
import { db } from '@/core/database';
import { useDatabaseMutationVersion } from '@/core/database/mutation';
import {
  importBundleZip,
  importLegacyBundleFile,
  ImportedBundle,
  ImportedEntitySnapshot,
  projectImportedSnapshots,
} from '@/core/bundles';
import { SearchDocumentRow } from '@/core/database/manager';
import { useTranslation } from '@/i18n';
import { Tweet, User } from '@/types';
import { useToggle } from '@/utils/common';

const INITIAL_PAGE_SIZE = 160;
const NEXT_PAGE_SIZE = 320;
const WARM_PREFETCH_TARGET = 960;

type BundleKindFilter = 'tweet' | 'user';

type BundleViewerState<T> = {
  records: T[];
  loading: boolean;
  loadingMore: boolean;
  loadedCount: number;
  totalCount: number;
  hasMore: boolean;
};

function isZipFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  return String(error);
}

function defaultBundleKind(bundle: ImportedBundle | null): BundleKindFilter {
  if (!bundle) return 'tweet';
  if (bundle.manifest?.counts?.tweets) return 'tweet';
  if (bundle.manifest?.counts?.users) return 'user';
  return 'tweet';
}

function useImportedBundles(show: boolean) {
  const mutationVersion = useDatabaseMutationVersion();
  const [bundles, setBundles] = useState<ImportedBundle[]>([]);

  const refresh = useCallback(async () => {
    setBundles(((await db.bundleList()) ?? []) as ImportedBundle[]);
  }, []);

  useEffect(() => {
    if (!show) return;
    void refresh();
  }, [mutationVersion, refresh, show]);

  return { bundles, refresh };
}

function useBundleSearchDocuments(bundleId: string, kind: BundleKindFilter): SearchDocumentRow[] {
  const mutationVersion = useDatabaseMutationVersion();
  const [documents, setDocuments] = useState<SearchDocumentRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!bundleId) {
      setDocuments([]);
      return;
    }
    void db
      .searchDocumentsForSource(`bundle:${bundleId}`, kind)
      .then((rows) => {
        if (!cancelled) {
          setDocuments(rows ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setDocuments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bundleId, kind, mutationVersion]);

  return documents;
}

function useBundleRecords<T extends Tweet | User>(
  bundleId: string,
  kind: BundleKindFilter,
): BundleViewerState<T> & {
  loadMore: () => Promise<void>;
  loadAll: () => Promise<void>;
  hydrateRecordsBySnapshotIds: (ids: string[]) => Promise<T[]>;
} {
  const mutationVersion = useDatabaseMutationVersion();
  const [state, setState] = useState<BundleViewerState<T>>({
    records: [],
    loading: false,
    loadingMore: false,
    loadedCount: 0,
    totalCount: 0,
    hasMore: false,
  });
  const offsetRef = useRef(0);
  const recordsRef = useRef<T[]>([]);
  const loadingMoreRef = useRef(false);

  const project = useCallback(
    (snapshots: ImportedEntitySnapshot[]): T[] =>
      projectImportedSnapshots(snapshots, kind) as unknown as T[],
    [kind],
  );

  const hydrateRecordsBySnapshotIds = useCallback(
    async (ids: string[]) => {
      const snapshots = ((await db.bundleGetSnapshotsByIds(ids)) ?? []).filter(
        (snapshot) => snapshot.kind === kind,
      );
      return project(snapshots);
    },
    [kind, project],
  );

  const loadPage = useCallback(
    async (offset: number, limit: number) => {
      const snapshots =
        ((await db.bundleGetSnapshotPage(bundleId, {
          kind,
          offset,
          limit,
          order: 'newest',
        })) as ImportedEntitySnapshot[]) ?? [];
      return project(snapshots);
    },
    [bundleId, kind, project],
  );

  const loadMore = useCallback(async () => {
    if (!bundleId || loadingMoreRef.current) return;
    if (state.totalCount > 0 && offsetRef.current >= state.totalCount) return;
    loadingMoreRef.current = true;
    setState((current) => ({ ...current, loadingMore: true }));
    try {
      const nextRecords = await loadPage(offsetRef.current, NEXT_PAGE_SIZE);
      const merged = [...recordsRef.current, ...nextRecords];
      offsetRef.current += nextRecords.length;
      recordsRef.current = merged;
      setState((current) => ({
        records: merged,
        loading: false,
        loadingMore: false,
        loadedCount: merged.length,
        totalCount: Math.max(current.totalCount, merged.length),
        hasMore: nextRecords.length >= NEXT_PAGE_SIZE,
      }));
    } finally {
      loadingMoreRef.current = false;
      setState((current) => ({ ...current, loadingMore: false }));
    }
  }, [bundleId, loadPage, state.totalCount]);

  const loadAll = useCallback(async () => {
    while (state.hasMore && offsetRef.current < state.totalCount) {
      const before = offsetRef.current;
      await loadMore();
      if (offsetRef.current === before) break;
    }
  }, [loadMore, state.hasMore, state.totalCount]);

  useEffect(() => {
    let cancelled = false;
    offsetRef.current = 0;
    recordsRef.current = [];
    if (!bundleId) {
      setState({
        records: [],
        loading: false,
        loadingMore: false,
        loadedCount: 0,
        totalCount: 0,
        hasMore: false,
      });
      return;
    }

    const load = async () => {
      setState({
        records: [],
        loading: true,
        loadingMore: false,
        loadedCount: 0,
        totalCount: 0,
        hasMore: false,
      });
      const [totalCount, firstRecords] = await Promise.all([
        db.bundleGetSnapshotCount(bundleId, kind),
        loadPage(0, INITIAL_PAGE_SIZE),
      ]);
      if (cancelled) return;
      offsetRef.current = firstRecords.length;
      recordsRef.current = firstRecords;
      setState({
        records: firstRecords,
        loading: false,
        loadingMore: false,
        loadedCount: firstRecords.length,
        totalCount: totalCount ?? firstRecords.length,
        hasMore: firstRecords.length < (totalCount ?? firstRecords.length),
      });
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [bundleId, kind, loadPage, mutationVersion]);

  useEffect(() => {
    if (state.loading || state.loadingMore || !state.hasMore) return;
    if (state.loadedCount >= WARM_PREFETCH_TARGET) return;
    const handle = globalThis.setTimeout(() => {
      void loadMore();
    }, 120);
    return () => globalThis.clearTimeout(handle);
  }, [loadMore, state.hasMore, state.loadedCount, state.loading, state.loadingMore]);

  return {
    ...state,
    loadMore,
    loadAll,
    hydrateRecordsBySnapshotIds,
  };
}

export function BundleViewerPanel() {
  const { t } = useTranslation();
  const [showModal, toggleShowModal] = useToggle(false);
  const [isViewerFullscreen, setIsViewerFullscreen] = useState(false);
  const [selectedBundleId, setSelectedBundleId] = useState('');
  const [kind, setKind] = useState<BundleKindFilter>('tweet');
  const [importStatus, setImportStatus] = useState('Idle');
  const [importing, setImporting] = useState(false);
  const { bundles, refresh } = useImportedBundles(showModal);
  const selectedBundle = bundles.find((bundle) => bundle.id === selectedBundleId) ?? null;
  const searchDocuments = useBundleSearchDocuments(selectedBundleId, kind);
  const recordsState = useBundleRecords<Tweet | User>(selectedBundleId, kind);
  const bookmarkFolderOptions = useMemo(() => {
    const counter = new Map<string, { label: string; count: number }>();
    for (const document of searchDocuments) {
      const folderId = String(document.folder_id || '').trim();
      if (!folderId) continue;
      const folderName = String(document.folder_name || '').trim();
      const current = counter.get(folderId);
      if (current) {
        current.count += 1;
      } else {
        counter.set(folderId, {
          label: folderName || `Folder ${folderId}`,
          count: 1,
        });
      }
    }
    return [...counter.entries()]
      .sort((left, right) => {
        if (right[1].count !== left[1].count) return right[1].count - left[1].count;
        return left[1].label.localeCompare(right[1].label);
      })
      .map(([value, meta]) => ({
        value,
        label: `${meta.label} (${meta.count})`,
      }));
  }, [searchDocuments]);

  useEffect(() => {
    if (!showModal || selectedBundleId || !bundles.length) return;
    const firstReady = bundles.find((bundle) => bundle.status === 'ready') ?? bundles[0];
    if (firstReady) {
      setSelectedBundleId(firstReady.id);
      setKind(defaultBundleKind(firstReady));
    }
  }, [bundles, selectedBundleId, showModal]);

  const importFile = async (file: File | null | undefined) => {
    if (!file || importing) return;
    const fileName = file.name || 'selected bundle';
    setImporting(true);
    setImportStatus(`Importing ${fileName}...`);
    let importedBundleId = '';
    try {
      const result = isZipFile(file)
        ? await importBundleZip(db, file)
        : await importLegacyBundleFile(db, file);
      importedBundleId = result.bundleId;
      setImportStatus(
        `Imported ${result.recordsImported}/${result.recordsSeen} records from ${fileName}`,
      );
    } catch (error) {
      setImportStatus(`Import failed: ${getErrorMessage(error)}`);
      setImporting(false);
      return;
    }

    try {
      await refresh();
      setSelectedBundleId(importedBundleId);
    } catch (error) {
      setImportStatus(`Imported ${fileName}, but refresh failed: ${getErrorMessage(error)}`);
    } finally {
      setImporting(false);
    }
  };

  const title = selectedBundle
    ? `${t('Bundle Viewer')}: ${selectedBundle.title}`
    : t('Bundle Viewer');
  const hasBundles = bundles.length > 0;

  return (
    <ExtensionPanel
      title={t('Bundle Viewer')}
      description={t('{{count}} imported bundles', { count: bundles.length })}
      active={hasBundles}
      onClick={toggleShowModal}
      indicatorColor="bg-accent"
      panelClass="my-1 rounded-box-half border border-accent/40 bg-accent/10 px-2 shadow-sm"
      buttonClass="btn-accent"
    >
      <Modal
        class={
          isViewerFullscreen
            ? 'h-screen max-h-screen max-w-none'
            : 'max-w-4xl md:max-w-screen-md sm:max-w-screen-sm h-[82vh] max-h-[calc(100vh-4rem)]'
        }
        title={t('Bundle Viewer')}
        show={showModal}
        fullscreen={isViewerFullscreen}
        onClose={() => {
          setIsViewerFullscreen(false);
          toggleShowModal();
        }}
      >
        <div class="flex min-h-0 grow flex-col gap-2">
          <section class="rounded-box-half border border-base-300 bg-base-200 px-2 py-1.5">
            <div class="flex flex-wrap items-center gap-2">
              <label class="btn btn-sm btn-outline">
                <IconDatabaseImport size={16} />
                Import Bundle
                <input
                  type="file"
                  accept=".zip,.json,.jsonl,application/zip,application/json,application/x-ndjson"
                  class="hidden"
                  disabled={importing}
                  onChange={(event) => {
                    const input = event.target as HTMLInputElement;
                    void importFile(input.files?.[0]);
                    input.value = '';
                  }}
                />
              </label>
              <select
                class="select select-bordered select-sm min-w-56"
                value={selectedBundleId}
                onChange={(event) => {
                  const nextId = (event.target as HTMLSelectElement).value;
                  const nextBundle = bundles.find((bundle) => bundle.id === nextId) ?? null;
                  setSelectedBundleId(nextId);
                  setKind(defaultBundleKind(nextBundle));
                }}
              >
                <option value="">Select imported bundle</option>
                {bundles.map((bundle) => (
                  <option key={bundle.id} value={bundle.id}>
                    {bundle.title} ({bundle.recordCount})
                  </option>
                ))}
              </select>
              <select
                class="select select-bordered select-sm"
                value={kind}
                onChange={(event) =>
                  setKind((event.target as HTMLSelectElement).value as BundleKindFilter)
                }
              >
                <option value="tweet">Tweets</option>
                <option value="user">Users</option>
              </select>
              <button class="btn btn-sm btn-ghost" onClick={() => void refresh()}>
                <IconRefresh size={16} />
                Refresh
              </button>
              {selectedBundle ? (
                <button
                  class="btn btn-sm btn-error btn-outline"
                  onClick={async () => {
                    if (!confirm(`Delete imported bundle "${selectedBundle.title}"?`)) return;
                    await db.bundleDelete(selectedBundle.id);
                    setSelectedBundleId('');
                    await refresh();
                  }}
                >
                  <IconTrash size={16} />
                  Delete
                </button>
              ) : null}
              <span class="font-mono text-[10px] opacity-70">
                {importing ? 'busy: ' : ''}
                {importStatus}
              </span>
            </div>
          </section>

          {selectedBundleId ? (
            kind === 'tweet' ? (
              <BaseTableView<Tweet>
                title={title}
                viewStateKey={`bundle:${selectedBundleId}:tweet`}
                fullscreen={isViewerFullscreen}
                onFullscreenChange={setIsViewerFullscreen}
                loading={recordsState.loading}
                loadingMore={recordsState.loadingMore}
                loadedCount={recordsState.loadedCount}
                totalCount={recordsState.totalCount}
                hasMore={recordsState.hasMore}
                loadMore={recordsState.loadMore}
                loadAll={recordsState.loadAll}
                hydrateRecordsByIds={
                  recordsState.hydrateRecordsBySnapshotIds as (ids: string[]) => Promise<Tweet[]>
                }
                records={recordsState.records as Tweet[]}
                searchDocuments={searchDocuments}
                columns={columnsTweet as ColumnDef<Tweet>[]}
                clear={() => undefined}
                showClearButton={false}
                alternateViews={[
                  {
                    id: 'media-masonry',
                    label: 'Media masonry',
                    icon: 'grid',
                    component: TweetMediaMasonry,
                  },
                ]}
                bookmarkFolderOptions={bookmarkFolderOptions}
                renderActions={() => (
                  <span class="badge badge-outline badge-sm font-mono">
                    imported bundle: {selectedBundle?.recordCount ?? 0} records
                  </span>
                )}
              />
            ) : (
              <BaseTableView<User>
                title={title}
                viewStateKey={`bundle:${selectedBundleId}:user`}
                fullscreen={isViewerFullscreen}
                onFullscreenChange={setIsViewerFullscreen}
                loading={recordsState.loading}
                loadingMore={recordsState.loadingMore}
                loadedCount={recordsState.loadedCount}
                totalCount={recordsState.totalCount}
                hasMore={recordsState.hasMore}
                loadMore={recordsState.loadMore}
                loadAll={recordsState.loadAll}
                hydrateRecordsByIds={
                  recordsState.hydrateRecordsBySnapshotIds as (ids: string[]) => Promise<User[]>
                }
                records={recordsState.records as User[]}
                searchDocuments={searchDocuments}
                columns={columnsUser as ColumnDef<User>[]}
                clear={() => undefined}
                showClearButton={false}
                renderActions={() => (
                  <span class="badge badge-outline badge-sm font-mono">
                    imported bundle: {selectedBundle?.recordCount ?? 0} records
                  </span>
                )}
              />
            )
          ) : (
            <div class="flex grow items-center justify-center rounded-box-half border border-base-300 bg-base-200 text-sm opacity-70">
              Import or select a bundle to open it in the explorer.
            </div>
          )}
        </div>
      </Modal>
    </ExtensionPanel>
  );
}
