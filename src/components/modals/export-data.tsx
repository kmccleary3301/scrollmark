import { useEffect, useRef, useState } from 'preact/hooks';
import { ColumnDef } from '@tanstack/table-core';
import { Modal } from '@/components/common';
import {
  exportCanonicalBundleZipWithWorker,
  type BundleExportWorkerJob,
} from '@/core/bundles/export-worker-client';
import { TranslationKey, useTranslation } from '@/i18n';
import { ResultSetSnapshot } from '@/utils/result-set';
import { useSignalState, cx, useToggle } from '@/utils/common';
import { DataType, EXPORT_FORMAT, ExportFormatType, exportData } from '@/utils/exporter';

type ExportScopeType = 'selected' | 'result_set';

type ExportRowSnapshot<T> = {
  id: string;
  original: T;
  record: DataType;
};

type ExportDataModalProps<T> = {
  title: string;
  columns: ColumnDef<T>[];
  resultRecords: T[];
  selectedRecords: T[];
  resultSetSnapshot: ResultSetSnapshot;
  selectionMode: 'all' | 'explicit';
  preparingFullDataset?: boolean;
  show?: boolean;
  onClose?: () => void;
};

function cloneSnapshotValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON cloning.
    }
  }

  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function getAccessorPathValue(record: unknown, path: string): unknown {
  if (!record || typeof record !== 'object') return undefined;
  const parts = path.split('.');
  let current: unknown = record;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function flattenLeafColumns<T>(columns: ColumnDef<T>[]): ColumnDef<T>[] {
  const out: ColumnDef<T>[] = [];
  for (const column of columns) {
    if ('columns' in column && Array.isArray(column.columns)) {
      out.push(...flattenLeafColumns(column.columns as ColumnDef<T>[]));
      continue;
    }
    out.push(column);
  }
  return out;
}

function resolveColumnId<T>(column: ColumnDef<T>): string {
  if ('id' in column && typeof column.id === 'string' && column.id) {
    return column.id;
  }
  if ('accessorKey' in column && typeof column.accessorKey === 'string') {
    return column.accessorKey;
  }
  return '';
}

function resolveColumnValue<T>(column: ColumnDef<T>, record: T, rowIndex: number): unknown {
  if ('accessorFn' in column && typeof column.accessorFn === 'function') {
    return column.accessorFn(record, rowIndex);
  }
  if ('accessorKey' in column) {
    if (typeof column.accessorKey === 'string') {
      return getAccessorPathValue(record, column.accessorKey);
    }
    if (typeof column.accessorKey === 'number' && Array.isArray(record)) {
      return record[column.accessorKey];
    }
  }
  return undefined;
}

function snapshotExportRow<T>(
  recordSource: T,
  columns: ColumnDef<T>[],
  rowIndex: number,
): ExportRowSnapshot<T> {
  const record: DataType = {};
  const leafColumns = flattenLeafColumns(columns);

  for (const column of leafColumns) {
    const meta = column.meta;

    if (meta?.exportable === false) {
      continue;
    }

    const baseValue = resolveColumnValue(column, recordSource, rowIndex);
    const exportRowLike = {
      original: recordSource,
    } as never;
    let exportValue = meta?.exportValue
      ? (meta.exportValue as (row: never) => unknown)(exportRowLike)
      : baseValue;
    if (exportValue === undefined) {
      exportValue = null;
    }

    record[meta?.exportKey || resolveColumnId(column)] = cloneSnapshotValue(exportValue);
  }

  const originalRecord = cloneSnapshotValue(recordSource) as Record<string, unknown>;
  if (
    originalRecord &&
    (originalRecord.__bookmark_folder_id ||
      originalRecord.__bookmark_folder_name ||
      originalRecord.__bookmark_folder_url)
  ) {
    const trustedFolderName =
      originalRecord.__bookmark_folder_name_source === 'api'
        ? (originalRecord.__bookmark_folder_name ?? null)
        : null;
    record.bookmark_folder_id = originalRecord.__bookmark_folder_id ?? null;
    record.bookmark_folder_name = trustedFolderName;
    record.bookmark_folder_url = originalRecord.__bookmark_folder_url ?? null;
  }

  return {
    id: String((originalRecord as Record<string, unknown>)?.rest_id || rowIndex),
    original: cloneSnapshotValue(recordSource),
    record,
  };
}

/**
 * Modal for exporting data.
 */
export function ExportDataModal<T>({
  title,
  columns,
  resultRecords,
  selectedRecords,
  resultSetSnapshot,
  selectionMode,
  preparingFullDataset = false,
  show,
  onClose,
}: ExportDataModalProps<T>) {
  const { t } = useTranslation('exporter');

  const [selectedFormat, setSelectedFormat] = useSignalState<ExportFormatType>(EXPORT_FORMAT.JSON);
  const [loading, setLoading] = useSignalState(false);
  const [bundleLoading, setBundleLoading] = useSignalState(false);

  const [includeMetadata, toggleIncludeMetadata] = useToggle(false);
  const [currentProgress, setCurrentProgress] = useSignalState(0);
  const [totalProgress, setTotalProgress] = useSignalState(0);
  const [exportScope, setExportScope] = useSignalState<ExportScopeType>('result_set');
  const [bundleCompressionLevel, setBundleCompressionLevel] = useSignalState<0 | 1 | 6>(1);
  const [pinnedResultSetSnapshot, setPinnedResultSetSnapshot] = useState<ResultSetSnapshot | null>(
    null,
  );
  const wasOpenRef = useRef(false);
  const bundleJobRef = useRef<BundleExportWorkerJob | null>(null);

  useEffect(() => {
    if (!show) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }

    wasOpenRef.current = true;

    setPinnedResultSetSnapshot({
      ...resultSetSnapshot,
      ids: [...resultSetSnapshot.ids],
      warnings: [...resultSetSnapshot.warnings],
    });
    setExportScope(
      selectedRecords.length > 0 && selectionMode === 'explicit' ? 'selected' : 'result_set',
    );
    setCurrentProgress(0);
    setTotalProgress(0);
  }, [
    resultSetSnapshot,
    selectedRecords,
    selectionMode,
    setCurrentProgress,
    setExportScope,
    setTotalProgress,
    show,
  ]);

  const activeSourceRecords = exportScope === 'selected' ? selectedRecords : resultRecords;
  const resultSetPreparing = preparingFullDataset && exportScope === 'result_set';
  const canExport = activeSourceRecords.length > 0 && !resultSetPreparing;

  const buildActiveRows = () =>
    activeSourceRecords.map((record, index) => snapshotExportRow(record, columns, index));

  const onExport = async () => {
    if (!canExport) return;
    setLoading(true);
    setCurrentProgress(0);
    setTotalProgress(activeSourceRecords.length);

    const allRecords: Array<DataType> = [];

    for (const row of buildActiveRows()) {
      const record = cloneSnapshotValue(row.record);
      if (includeMetadata) {
        record.metadata = cloneSnapshotValue(row.original);
      }
      allRecords.push(record);
      setCurrentProgress(allRecords.length);
    }

    // Prepare header translations for the exported data.
    const headerTranslations = flattenLeafColumns(columns).reduce<Record<string, string>>(
      (acc, column) => {
        const key = column.meta?.exportKey || resolveColumnId(column);
        const header = column.meta?.exportHeader || resolveColumnId(column);
        acc[key] = t(header as TranslationKey);
        return acc;
      },
      {},
    );

    // Convert data to selected format and download it.
    await exportData(
      allRecords,
      selectedFormat,
      `twitter-${title}-${exportScope === 'selected' ? 'selected' : 'results'}-${Date.now()}.${selectedFormat.toLowerCase()}`,
      headerTranslations,
    );
    setLoading(false);
  };

  const onExportBundle = async () => {
    if (!canExport) return;
    setBundleLoading(true);
    setCurrentProgress(0);
    setTotalProgress(activeSourceRecords.length);
    try {
      const activeRows = buildActiveRows();
      const job = exportCanonicalBundleZipWithWorker({
        rows: activeRows,
        options: {
          title,
          scope: exportScope,
          queryText: pinnedResultSetSnapshot?.queryText,
          sort: pinnedResultSetSnapshot?.sort,
          includeOriginalMetadata: includeMetadata,
          compressionLevel: bundleCompressionLevel,
        },
        onProgress: (progress) => {
          setCurrentProgress(progress.processedRecords);
          setTotalProgress(progress.totalRecords);
        },
      });
      bundleJobRef.current = job;
      await job.promise;
      setCurrentProgress(activeSourceRecords.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/cancelled/i.test(message)) {
        console.error('[twitter-web-exporter] Failed to export bundle ZIP.', error);
      }
    } finally {
      bundleJobRef.current = null;
      setBundleLoading(false);
    }
  };

  const onCancel = () => {
    if (bundleLoading) {
      bundleJobRef.current?.cancel();
      bundleJobRef.current = null;
      setBundleLoading(false);
      return;
    }
    onClose?.();
  };

  return (
    <Modal
      class="max-w-sm md:max-w-screen-sm sm:max-w-screen-sm max-h-full"
      title={`${title} ${t('Data')}`}
      show={show}
      onClose={onClose}
    >
      {/* Modal content. */}
      <div class="px-4 text-base">
        <p class="text-base-content text-opacity-60 mb-2 leading-5 text-sm">
          {t(
            'Export captured data as JSON/HTML/CSV file. This may take a while depending on the amount of data. The exported file does not include media files such as images and videos but only the URLs.',
          )}
        </p>
        {/* Export options. */}
        <div class="flex items-center">
          <p class="mr-2 leading-8">{t('Data length:')}</p>
          <span class="font-mono leading-6 h-6 bg-base-200 px-2 rounded-md">
            {activeSourceRecords.length}
          </span>
          {resultSetPreparing ? (
            <span class="ml-2 inline-flex items-center gap-1 text-xs opacity-70">
              <span class="loading loading-spinner loading-xs" />
              loading remaining rows
            </span>
          ) : null}
        </div>
        <div class="flex items-center gap-4">
          <p class="leading-8">{t('Export scope:')}</p>
          <label class="label cursor-pointer gap-2 py-0">
            <input
              type="radio"
              name="export-scope"
              class="radio radio-sm"
              checked={exportScope === 'result_set'}
              onChange={() => setExportScope('result_set')}
            />
            <span>{t('All current results')}</span>
            <span class="font-mono opacity-60">({resultRecords.length})</span>
          </label>
          <label
            class={cx('label cursor-pointer gap-2 py-0', !selectedRecords.length && 'opacity-50')}
          >
            <input
              type="radio"
              name="export-scope"
              class="radio radio-sm"
              checked={exportScope === 'selected'}
              disabled={!selectedRecords.length}
              onChange={() => setExportScope('selected')}
            />
            <span>{t('Selected rows')}</span>
            <span class="font-mono opacity-60">({selectedRecords.length})</span>
          </label>
        </div>
        {pinnedResultSetSnapshot ? (
          <div class="rounded-box-half border border-base-300 bg-base-200/60 px-3 py-2 text-xs leading-5">
            <div class="font-semibold">{t('Pinned result set')}</div>
            <div class="font-mono opacity-70">{pinnedResultSetSnapshot.resultSetId}</div>
            <div>
              {t('Query')}:{' '}
              <span class="font-mono">{pinnedResultSetSnapshot.queryText || '-'}</span>
            </div>
            <div>
              {t('Sort')}: <span class="font-mono">{pinnedResultSetSnapshot.sort}</span>
            </div>
          </div>
        ) : null}
        <div class="flex items-center">
          <p class="mr-2 leading-8">{t('Include all metadata:')}</p>
          <input
            type="checkbox"
            class="checkbox checkbox-sm"
            checked={includeMetadata}
            onChange={toggleIncludeMetadata}
          />
        </div>
        <div class="flex">
          <p class="mr-2 leading-8">{t('Export as:')}</p>
          <select
            class="select select-bordered select-sm w-32"
            onChange={(e) => {
              setSelectedFormat((e.target as HTMLSelectElement).value as ExportFormatType);
            }}
          >
            {Object.values(EXPORT_FORMAT).map((type) => (
              <option key={type} selected={type === selectedFormat}>
                {type}
              </option>
            ))}
          </select>
        </div>
        <div class="flex items-center gap-2">
          <p class="leading-8">Bundle ZIP compression:</p>
          <select
            class="select select-bordered select-sm w-44"
            value={String(bundleCompressionLevel)}
            onChange={(e) =>
              setBundleCompressionLevel(Number((e.target as HTMLSelectElement).value) as 0 | 1 | 6)
            }
          >
            <option value="0">Fastest / store</option>
            <option value="1">Balanced / fast</option>
            <option value="6">Smaller / slower</option>
          </select>
        </div>
        {activeSourceRecords.length > 0 ? null : (
          <div class="flex items-center justify-center h-28 w-full">
            <p class="text-base-content text-opacity-50">{t('No data selected.')}</p>
          </div>
        )}
        {/* Progress bar. */}
        <div class="flex flex-col mt-6">
          <progress
            class="progress progress-primary w-full"
            value={(currentProgress / (totalProgress || 1)) * 100}
            max="100"
          />
          <span class="text-sm leading-none mt-2 text-base-content text-opacity-60">
            {`${currentProgress}/${activeSourceRecords.length}`}
          </span>
        </div>
      </div>
      {/* Action buttons. */}
      <div class="flex space-x-2">
        <span class="flex-grow" />
        <button class="btn" onClick={onCancel}>
          {bundleLoading ? 'Cancel Export' : t('Cancel')}
        </button>
        <button
          class={cx('btn btn-secondary', (bundleLoading || !canExport) && 'btn-disabled')}
          onClick={onExportBundle}
          title="Export a canonical portable ZIP bundle for sharing/importing."
        >
          {bundleLoading && <span class="loading loading-spinner" />}
          Export Bundle ZIP
        </button>
        <button
          class={cx('btn btn-primary', (loading || !canExport) && 'btn-disabled')}
          onClick={onExport}
        >
          {loading && <span class="loading loading-spinner" />}
          {t('Start Export')}
        </button>
      </div>
    </Modal>
  );
}
