import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ColumnDef } from '@tanstack/table-core';
import { Modal } from '@/components/common';
import {
  exportCanonicalBundleZipWithWorker,
  type BundleExportWorkerJob,
} from '@/core/bundles/export-worker-client';
import { createCompanionNamespaceBundle } from '@/core/bundles/companion-bridge';
import { CompanionClient } from '@/core/durability/companion-client';
import { readPairingContext } from '@/core/durability/identity';
import { TranslationKey, useTranslation } from '@/i18n';
import { nowMs, recordPerfMetric } from '@/core/perf/metrics';
import { extractStableRecordId, ResultSetSnapshot } from '@/utils/result-set';
import { useSignalState, cx } from '@/utils/common';
import {
  DataType,
  EXPORT_FORMAT,
  ExportFormatType,
  exportData,
  exportDataFromAsyncRows,
  saveFile,
} from '@/utils/exporter';
import { options } from '@/core/options';
import {
  applyMetadataToRecord,
  cloneSnapshotValue as cloneMetadataValue,
  DEFAULT_METADATA_FIELDS,
  type ExportMetadataMode,
  normalizeMetadataFields,
} from '@/utils/export-metadata';

type ExportScopeType = 'selected' | 'result_set';
type ExportColumnMode = 'all' | 'custom';

type ExportColumnOption = {
  key: string;
  label: string;
};

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
  selectedRecordCount?: number;
  selectionExcludedRecordIds?: string[];
  resultCount?: number;
  streamResultRecords?: () => AsyncIterable<T>;
  streamSelectedRecords?: () => AsyncIterable<T>;
  resultSetSnapshot: ResultSetSnapshot;
  selectionMode: 'all' | 'explicit';
  preparingFullDataset?: boolean;
  show?: boolean;
  onClose?: () => void;
};

function cloneSnapshotValue<T>(value: T): T {
  return cloneMetadataValue(value);
}

function normalizeExportColumnFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function getExportColumnOptions<T>(columns: ColumnDef<T>[]): ExportColumnOption[] {
  return flattenLeafColumns(columns)
    .filter((column) => column.meta?.exportable !== false)
    .map((column) => ({
      key: column.meta?.exportKey || resolveColumnId(column),
      label: column.meta?.exportHeader || resolveColumnId(column),
    }))
    .filter((column) => !!column.key);
}

function sanitizeExportColumnFields(
  fields: unknown,
  availableColumns: ExportColumnOption[],
): string[] {
  const available = new Set(availableColumns.map((column) => column.key));
  return normalizeExportColumnFields(fields).filter((field) => available.has(field));
}

function getExportColumnSignature(availableColumns: ExportColumnOption[]): string {
  return JSON.stringify(availableColumns.map((column) => column.key).sort());
}

function hasMatchingExportColumnSignature(availableColumns: ExportColumnOption[]): boolean {
  return options.get('exportColumnSignature', '') === getExportColumnSignature(availableColumns);
}

function getInitialExportColumnMode(availableColumns: ExportColumnOption[]): ExportColumnMode {
  return hasMatchingExportColumnSignature(availableColumns) &&
    options.get('exportColumnMode') === 'custom'
    ? 'custom'
    : 'all';
}

function getInitialExportColumnFields(availableColumns: ExportColumnOption[]): string[] {
  if (!hasMatchingExportColumnSignature(availableColumns)) {
    return availableColumns.map((column) => column.key);
  }
  const storedFields = normalizeExportColumnFields(options.get('exportColumnFields'));
  const sanitizedFields = sanitizeExportColumnFields(storedFields, availableColumns);
  if (storedFields.length > 0 && sanitizedFields.length === 0) {
    return availableColumns.map((column) => column.key);
  }
  return sanitizedFields;
}

function filterRecordColumns(record: DataType, mode: ExportColumnMode, fields: string[]): DataType {
  if (mode === 'all') return record;
  const selected = new Set(fields);
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => selected.has(key)),
  ) as DataType;
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
    id: extractStableRecordId(originalRecord, rowIndex),
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
  selectedRecordCount,
  selectionExcludedRecordIds = [],
  resultCount,
  streamResultRecords,
  streamSelectedRecords,
  resultSetSnapshot,
  selectionMode,
  preparingFullDataset = false,
  show,
  onClose,
}: ExportDataModalProps<T>) {
  const { t } = useTranslation('exporter');
  const companionPairing = readPairingContext();

  const [selectedFormat, setSelectedFormat] = useSignalState<ExportFormatType>(EXPORT_FORMAT.JSON);
  const [loading, setLoading] = useSignalState(false);
  const [bundleLoading, setBundleLoading] = useSignalState(false);

  const exportColumnOptions = useMemo(() => getExportColumnOptions(columns), [columns]);
  const [columnMode, setColumnMode] = useSignalState<ExportColumnMode>(
    getInitialExportColumnMode(exportColumnOptions),
  );
  const [columnFields, setColumnFields] = useSignalState<string[]>(
    getInitialExportColumnFields(exportColumnOptions),
  );

  const initialMetadataMode = options.get('exportMetadataMode');
  const [metadataMode, setMetadataMode] = useSignalState<ExportMetadataMode>(
    initialMetadataMode === 'all' || initialMetadataMode === 'custom'
      ? initialMetadataMode
      : 'none',
  );
  const [metadataFields, setMetadataFields] = useSignalState<string[]>(
    normalizeMetadataFields(options.get('exportMetadataFields')),
  );
  const selectedColumnFieldSet = useMemo(() => new Set(columnFields), [columnFields]);
  const selectedMetadataFieldSet = useMemo(() => new Set(metadataFields), [metadataFields]);
  const [currentProgress, setCurrentProgress] = useSignalState(0);
  const [totalProgress, setTotalProgress] = useSignalState(0);
  const [exportScope, setExportScope] = useSignalState<ExportScopeType>('result_set');
  const [bundleCompressionLevel, setBundleCompressionLevel] = useSignalState<0 | 1 | 6>(1);
  const [bundleIncludeOriginalMetadata, setBundleIncludeOriginalMetadata] = useSignalState<boolean>(
    options.get('bundleIncludeOriginalMetadata', false) === true,
  );
  const [pinnedResultSetSnapshot, setPinnedResultSetSnapshot] = useState<ResultSetSnapshot | null>(
    null,
  );
  const wasOpenRef = useRef(false);
  const bundleJobRef = useRef<BundleExportWorkerJob | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const bundleAbortRef = useRef<AbortController | null>(null);
  const exportCancelReportedRef = useRef(false);

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
    setColumnMode(getInitialExportColumnMode(exportColumnOptions));
    setColumnFields(getInitialExportColumnFields(exportColumnOptions));
  }, [
    exportColumnOptions,
    resultSetSnapshot,
    selectedRecords,
    selectionMode,
    setColumnFields,
    setColumnMode,
    setCurrentProgress,
    setExportScope,
    setTotalProgress,
    show,
  ]);

  const resultSetRawCount =
    resultCount ?? pinnedResultSetSnapshot?.totalMatches ?? resultRecords.length;
  const excludedRecordIdSet = useMemo(
    () => new Set(selectionMode === 'all' ? selectionExcludedRecordIds : []),
    [selectionExcludedRecordIds, selectionMode],
  );
  const resultSetExcludedCount =
    selectionMode === 'all' ? Math.min(excludedRecordIdSet.size, resultSetRawCount) : 0;
  const resultSetCount = Math.max(0, resultSetRawCount - resultSetExcludedCount);
  const selectedCount = selectedRecordCount ?? selectedRecords.length;
  const activeSourceRecords = exportScope === 'selected' ? selectedRecords : resultRecords;
  const activeSourceCount = exportScope === 'selected' ? selectedCount : resultSetCount;
  const canStreamResultSet = exportScope === 'result_set' && Boolean(streamResultRecords);
  const canStreamSelected = exportScope === 'selected' && Boolean(streamSelectedRecords);
  const canStreamActiveScope = canStreamResultSet || canStreamSelected;
  const resultSetPreparing = preparingFullDataset && exportScope === 'result_set';
  const canExport = activeSourceCount > 0 && !resultSetPreparing;

  const shouldSkipResultSetRow = (rowId: string) =>
    exportScope === 'result_set' && excludedRecordIdSet.has(rowId);

  const buildActiveRows = () => {
    const rows: Array<ExportRowSnapshot<T>> = [];
    activeSourceRecords.forEach((record, index) => {
      const row = snapshotExportRow(record, columns, index);
      if (shouldSkipResultSetRow(row.id)) {
        return;
      }
      rows.push(row);
    });
    return rows;
  };

  const buildExportRecord = (row: ExportRowSnapshot<T>): DataType => {
    const record = filterRecordColumns(cloneSnapshotValue(row.record), columnMode, columnFields);
    applyMetadataToRecord(record, row.original, metadataMode, metadataFields);
    return record;
  };

  const updateColumnMode = (mode: ExportColumnMode) => {
    if (mode === 'custom' && columnFields.length === 0) {
      updateColumnFields(exportColumnOptions.map((column) => column.key));
    }
    setColumnMode(mode);
    options.set('exportColumnMode', mode);
    options.set('exportColumnSignature', getExportColumnSignature(exportColumnOptions));
  };

  const updateColumnFields = (fields: string[]) => {
    const normalized = sanitizeExportColumnFields(fields, exportColumnOptions);
    setColumnFields(normalized);
    options.set('exportColumnFields', normalized);
    options.set('exportColumnSignature', getExportColumnSignature(exportColumnOptions));
  };

  const toggleColumnField = (field: string) => {
    const next = selectedColumnFieldSet.has(field)
      ? columnFields.filter((item) => item !== field)
      : [...columnFields, field];
    updateColumnFields(next);
    if (columnMode === 'all') {
      updateColumnMode('custom');
    }
  };

  const updateMetadataMode = (mode: ExportMetadataMode) => {
    setMetadataMode(mode);
    options.set('exportMetadataMode', mode);
  };

  const updateMetadataFields = (fields: string[]) => {
    const normalized = normalizeMetadataFields(fields);
    setMetadataFields(normalized);
    options.set('exportMetadataFields', normalized);
  };

  const toggleMetadataField = (field: string) => {
    const next = selectedMetadataFieldSet.has(field)
      ? metadataFields.filter((item) => item !== field)
      : [...metadataFields, field];
    updateMetadataFields(next);
    if (metadataMode === 'none') {
      updateMetadataMode('custom');
    }
  };

  async function* streamActiveExportRecords(): AsyncIterable<DataType> {
    if (canStreamResultSet && streamResultRecords) {
      let index = 0;
      for await (const record of streamResultRecords()) {
        const row = snapshotExportRow(record, columns, index);
        index += 1;
        if (shouldSkipResultSetRow(row.id)) {
          continue;
        }
        yield buildExportRecord(row);
      }
      return;
    }
    if (canStreamSelected && streamSelectedRecords) {
      let index = 0;
      for await (const record of streamSelectedRecords()) {
        const row = snapshotExportRow(record, columns, index);
        index += 1;
        yield buildExportRecord(row);
      }
      return;
    }

    for (const row of buildActiveRows()) {
      yield buildExportRecord(row);
    }
  }

  const onExport = async () => {
    if (!canExport) return;
    const abortController = new AbortController();
    const startedAt = nowMs();
    exportCancelReportedRef.current = false;
    exportAbortRef.current = abortController;
    setLoading(true);
    setCurrentProgress(0);
    setTotalProgress(activeSourceCount);
    recordPerfMetric({
      kind: 'export',
      name: 'modal-export-start',
      value: activeSourceCount,
      tags: {
        scope: exportScope,
        format: selectedFormat,
        streaming: canStreamActiveScope,
        excluded: resultSetExcludedCount,
      },
    });

    const headerTranslations = flattenLeafColumns(columns).reduce<Record<string, string>>(
      (acc, column) => {
        const key = column.meta?.exportKey || resolveColumnId(column);
        const header = column.meta?.exportHeader || resolveColumnId(column);
        acc[key] = t(header as TranslationKey);
        return acc;
      },
      {},
    );

    if (canStreamActiveScope) {
      await exportDataFromAsyncRows(
        streamActiveExportRecords(),
        selectedFormat,
        `twitter-${title}-${exportScope === 'selected' ? 'selected' : 'results'}-${Date.now()}.${selectedFormat.toLowerCase()}`,
        headerTranslations,
        {
          onProgress: setCurrentProgress,
          signal: abortController.signal,
        },
      );
      exportAbortRef.current = null;
      setLoading(false);
      if (abortController.signal.aborted) {
        if (!exportCancelReportedRef.current) {
          recordPerfMetric({
            kind: 'export',
            name: 'modal-export-cancel',
            durationMs: nowMs() - startedAt,
            value: currentProgress,
            tags: {
              scope: exportScope,
              format: selectedFormat,
              streaming: true,
              excluded: resultSetExcludedCount,
            },
          });
        }
        return;
      }
      recordPerfMetric({
        kind: 'export',
        name: 'modal-export-complete',
        durationMs: nowMs() - startedAt,
        value: activeSourceCount,
        tags: {
          scope: exportScope,
          format: selectedFormat,
          streaming: true,
          excluded: resultSetExcludedCount,
        },
      });
      return;
    }

    const allRecords: Array<DataType> = [];

    for (const row of buildActiveRows()) {
      if (abortController.signal.aborted) {
        exportAbortRef.current = null;
        setLoading(false);
        return;
      }
      allRecords.push(buildExportRecord(row));
      setCurrentProgress(allRecords.length);
    }
    recordPerfMetric({
      kind: 'export',
      name: 'modal-array-export-rows',
      value: allRecords.length,
      tags: {
        scope: exportScope,
        format: selectedFormat,
        excluded: resultSetExcludedCount,
      },
    });

    // Convert data to selected format and download it.
    await exportData(
      allRecords,
      selectedFormat,
      `twitter-${title}-${exportScope === 'selected' ? 'selected' : 'results'}-${Date.now()}.${selectedFormat.toLowerCase()}`,
      headerTranslations,
    );
    exportAbortRef.current = null;
    setLoading(false);
    recordPerfMetric({
      kind: 'export',
      name: 'modal-export-complete',
      durationMs: nowMs() - startedAt,
      value: allRecords.length,
      tags: {
        scope: exportScope,
        format: selectedFormat,
        streaming: false,
        excluded: resultSetExcludedCount,
      },
    });
  };

  async function* streamActiveBundleRows(signal: AbortSignal): AsyncIterable<ExportRowSnapshot<T>> {
    if (canStreamResultSet && streamResultRecords) {
      let index = 0;
      for await (const record of streamResultRecords()) {
        if (signal.aborted) {
          return;
        }
        const row = snapshotExportRow(record, columns, index);
        index += 1;
        if (shouldSkipResultSetRow(row.id)) {
          continue;
        }
        yield row;
      }
      return;
    }
    if (canStreamSelected && streamSelectedRecords) {
      let index = 0;
      for await (const record of streamSelectedRecords()) {
        if (signal.aborted) {
          return;
        }
        yield snapshotExportRow(record, columns, index);
        index += 1;
      }
      return;
    }

    for (const row of buildActiveRows()) {
      if (signal.aborted) {
        return;
      }
      yield row;
    }
  }

  const onExportBundle = async () => {
    if (!canExport) return;
    const abortController = new AbortController();
    bundleAbortRef.current = abortController;
    setBundleLoading(true);
    setCurrentProgress(0);
    setTotalProgress(activeSourceCount);
    try {
      const job = exportCanonicalBundleZipWithWorker({
        rows: streamActiveBundleRows(abortController.signal),
        totalRecords: activeSourceCount,
        options: {
          title,
          scope: exportScope,
          queryText: pinnedResultSetSnapshot?.queryText,
          sort: pinnedResultSetSnapshot?.sort,
          // Column and flat-file metadata filters do not alter the
          // canonical record shape required for bundle imports.
          includeOriginalMetadata: bundleIncludeOriginalMetadata,
          compressionLevel: bundleCompressionLevel,
        },
        onProgress: (progress) => {
          setCurrentProgress(progress.processedRecords);
          setTotalProgress(progress.totalRecords);
        },
      });
      bundleJobRef.current = job;
      await job.promise;
      if (abortController.signal.aborted) return;
      setCurrentProgress(activeSourceCount);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/cancelled/i.test(message)) {
        console.error('[twitter-web-exporter] Failed to export bundle ZIP.', error);
      }
    } finally {
      bundleJobRef.current = null;
      bundleAbortRef.current = null;
      setBundleLoading(false);
    }
  };

  const onExportCompanionBundle = async () => {
    if (!companionPairing || bundleLoading) return;
    const abortController = new AbortController();
    bundleAbortRef.current = abortController;
    setBundleLoading(true);
    setCurrentProgress(0);
    setTotalProgress(0);
    try {
      const result = await createCompanionNamespaceBundle({
        pairing: companionPairing,
        client: new CompanionClient(companionPairing),
        title: `${title} canonical namespace`,
        description: 'Read-only export from the paired Scrollmark companion canonical namespace.',
        compressionLevel: bundleCompressionLevel,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) return;
      const blobBytes = result.bytes.buffer.slice(
        result.bytes.byteOffset,
        result.bytes.byteOffset + result.bytes.byteLength,
      ) as ArrayBuffer;
      saveFile(result.filename, new Blob([blobBytes], { type: 'application/zip' }));
      setCurrentProgress(result.companionSource.records.total);
      setTotalProgress(result.companionSource.records.total);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/cancelled/i.test(message)) {
        console.error('[twitter-web-exporter] Failed to export canonical companion bundle.', error);
      }
    } finally {
      bundleJobRef.current = null;
      bundleAbortRef.current = null;
      setBundleLoading(false);
    }
  };

  const onCancel = () => {
    if (loading) {
      exportAbortRef.current?.abort();
      exportCancelReportedRef.current = true;
      recordPerfMetric({
        kind: 'export',
        name: 'modal-export-cancel',
        value: currentProgress,
        tags: {
          scope: exportScope,
          format: selectedFormat,
          streaming: canStreamActiveScope,
        },
      });
      exportAbortRef.current = null;
      setLoading(false);
      return;
    }
    if (bundleLoading) {
      bundleAbortRef.current?.abort();
      bundleJobRef.current?.cancel();
      bundleJobRef.current = null;
      bundleAbortRef.current = null;
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
            {activeSourceCount}
          </span>
          {resultSetPreparing ? (
            <span class="ml-2 inline-flex items-center gap-1 text-xs opacity-70">
              <span class="loading loading-spinner loading-xs" />
              {t('loading remaining rows')}
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
            <span class="font-mono opacity-60">({resultSetCount})</span>
          </label>
          <label class={cx('label cursor-pointer gap-2 py-0', selectedCount <= 0 && 'opacity-50')}>
            <input
              type="radio"
              name="export-scope"
              class="radio radio-sm"
              checked={exportScope === 'selected'}
              disabled={selectedCount <= 0}
              onChange={() => setExportScope('selected')}
            />
            <span>{t('Selected rows')}</span>
            <span class="font-mono opacity-60">({selectedCount})</span>
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
        <div class="rounded-box-half border border-base-300 bg-base-200/60 px-3 py-2">
          <div class="mb-2 flex flex-wrap items-center gap-4">
            <p class="font-semibold text-sm">{t('Export columns')}</p>
            <label class="label cursor-pointer gap-2 py-0">
              <input
                type="radio"
                name="export-column-mode"
                class="radio radio-sm"
                checked={columnMode === 'all'}
                onChange={() => updateColumnMode('all')}
              />
              <span>{t('All')}</span>
            </label>
            <label class="label cursor-pointer gap-2 py-0">
              <input
                type="radio"
                name="export-column-mode"
                class="radio radio-sm"
                checked={columnMode === 'custom'}
                onChange={() => updateColumnMode('custom')}
              />
              <span>{t('Custom columns')}</span>
            </label>
            {columnMode === 'custom' ? (
              <div class="ml-auto flex gap-2">
                <button
                  type="button"
                  class="btn btn-xs"
                  onClick={() =>
                    updateColumnFields(exportColumnOptions.map((column) => column.key))
                  }
                >
                  {t('Select all')}
                </button>
                <button type="button" class="btn btn-xs" onClick={() => updateColumnFields([])}>
                  {t('Clear')}
                </button>
              </div>
            ) : null}
          </div>
          {columnMode === 'custom' ? (
            <div class="space-y-2">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {exportColumnOptions.map((column) => (
                  <label key={column.key} class="label cursor-pointer justify-start gap-2 py-0">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-xs"
                      checked={selectedColumnFieldSet.has(column.key)}
                      onChange={() => toggleColumnField(column.key)}
                    />
                    <span>{t(column.label as TranslationKey)}</span>
                    <span class="font-mono opacity-60 break-all">{column.key}</span>
                  </label>
                ))}
              </div>
              <p class="text-xs opacity-60">
                {columnFields.length} {t('columns selected')}
              </p>
            </div>
          ) : null}
        </div>
        <div class="rounded-box-half border border-base-300 bg-base-200/60 px-3 py-2">
          <div class="mb-2 flex flex-wrap items-center gap-4">
            <p class="font-semibold text-sm">{t('Metadata')}</p>
            <label class="label cursor-pointer gap-2 py-0">
              <input
                type="radio"
                name="export-metadata-mode"
                class="radio radio-sm"
                checked={metadataMode === 'none'}
                onChange={() => updateMetadataMode('none')}
              />
              <span>{t('None')}</span>
            </label>
            <label class="label cursor-pointer gap-2 py-0">
              <input
                type="radio"
                name="export-metadata-mode"
                class="radio radio-sm"
                checked={metadataMode === 'all'}
                onChange={() => updateMetadataMode('all')}
              />
              <span>{t('All')}</span>
            </label>
            <label class="label cursor-pointer gap-2 py-0">
              <input
                type="radio"
                name="export-metadata-mode"
                class="radio radio-sm"
                checked={metadataMode === 'custom'}
                onChange={() => updateMetadataMode('custom')}
              />
              <span>{t('Custom fields')}</span>
            </label>
          </div>
          {metadataMode === 'custom' ? (
            <div class="space-y-2">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {DEFAULT_METADATA_FIELDS.map((field) => (
                  <label key={field} class="label cursor-pointer justify-start gap-2 py-0">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-xs"
                      checked={selectedMetadataFieldSet.has(field)}
                      onChange={() => toggleMetadataField(field)}
                    />
                    <span class="font-mono break-all">{field}</span>
                  </label>
                ))}
              </div>
              <label class="form-control">
                <span class="label-text text-xs">{t('Additional metadata paths')}</span>
                <textarea
                  class="textarea textarea-bordered textarea-sm font-mono text-xs min-h-16"
                  value={metadataFields
                    .filter((field) => !DEFAULT_METADATA_FIELDS.includes(field as never))
                    .join('\n')}
                  placeholder={'legacy.conversation_id_str\nviews.count'}
                  onInput={(e) => {
                    const customFields = (e.currentTarget as HTMLTextAreaElement).value
                      .split(/\r?\n|,/)
                      .map((item) => item.trim())
                      .filter(Boolean);
                    updateMetadataFields([
                      ...DEFAULT_METADATA_FIELDS.filter((field) =>
                        selectedMetadataFieldSet.has(field),
                      ),
                      ...customFields,
                    ]);
                  }}
                />
              </label>
              <p class="text-xs opacity-60">
                {metadataFields.length} {t('metadata fields selected')}
              </p>
            </div>
          ) : null}
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
          <p class="leading-8">{t('Bundle ZIP compression:')}</p>
          <select
            class="select select-bordered select-sm w-44"
            value={String(bundleCompressionLevel)}
            onChange={(e) =>
              setBundleCompressionLevel(Number((e.target as HTMLSelectElement).value) as 0 | 1 | 6)
            }
          >
            <option value="0">{t('Fastest / store')}</option>
            <option value="1">{t('Balanced / fast')}</option>
            <option value="6">{t('Smaller / slower')}</option>
          </select>
        </div>
        <label class="label cursor-pointer justify-start gap-2 py-0">
          <input
            type="checkbox"
            class="checkbox checkbox-sm"
            checked={bundleIncludeOriginalMetadata}
            onChange={(event) => {
              const checked = (event.currentTarget as HTMLInputElement).checked;
              setBundleIncludeOriginalMetadata(checked);
              options.set('bundleIncludeOriginalMetadata', checked);
            }}
          />
          <span>{t('Include original record metadata in bundle:')}</span>
        </label>
        {activeSourceCount > 0 || companionPairing ? null : (
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
            {`${currentProgress}/${totalProgress || activeSourceCount}`}
          </span>
        </div>
      </div>
      {/* Action buttons. */}
      <div class="flex space-x-2">
        <span class="flex-grow" />
        <button class="btn" onClick={onCancel}>
          {bundleLoading || loading ? t('Cancel Export') : t('Cancel')}
        </button>
        <button
          class={cx('btn btn-secondary', (bundleLoading || !canExport) && 'btn-disabled')}
          onClick={onExportBundle}
          title={t('Export a canonical portable ZIP bundle for sharing/importing.')}
        >
          {bundleLoading && <span class="loading loading-spinner" />}
          {t('Export Bundle ZIP')}
        </button>
        <button
          class={cx('btn btn-info', (bundleLoading || !companionPairing) && 'btn-disabled')}
          disabled={bundleLoading || !companionPairing}
          onClick={onExportCompanionBundle}
          title={
            companionPairing
              ? t('Export the paired canonical namespace as a verified shared-safe bundle.')
              : t('Pair a local companion to export its canonical namespace.')
          }
        >
          {bundleLoading && <span class="loading loading-spinner" />}
          {t('Export Companion Namespace')}
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
