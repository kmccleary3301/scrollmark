import BundleExportWorkerCtor from './export-worker?worker&inline';
import { nowMs, recordPerfMetric, setWorkerAvailability } from '@/core/perf/metrics';
import { saveFile } from '@/utils/exporter';
import type { BundleExportOptions, BundleExportProgress, BundleExportSourceRow } from './exporter';
import type {
  BundleExportWorkerRequest,
  BundleExportWorkerResponse,
} from './export-worker-contracts';

const BUNDLE_EXPORT_WORKER_BATCH_SIZE = 100;
const BUNDLE_EXPORT_BATCH_DELAY_KEY = 'twe_bundle_export_batch_delay_ms_v1';

function createJobId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `bundle-${crypto.randomUUID()}`;
  }
  return `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type ExportBundleWithWorkerOptions<T> = {
  rows: Iterable<BundleExportSourceRow<T>> | AsyncIterable<BundleExportSourceRow<T>>;
  totalRecords: number;
  options: Omit<BundleExportOptions, 'onProgress'>;
  onProgress?: (progress: BundleExportProgress) => void;
  batchSize?: number;
};

export type BundleExportWorkerJob = {
  jobId: string;
  promise: Promise<string>;
  cancel: () => void;
};

function isAsyncIterable<T>(rows: unknown): rows is AsyncIterable<T> {
  return (
    !!rows &&
    typeof rows === 'object' &&
    Symbol.asyncIterator in (rows as Record<PropertyKey, unknown>)
  );
}

async function* toAsyncRows<T>(
  rows: Iterable<BundleExportSourceRow<T>> | AsyncIterable<BundleExportSourceRow<T>>,
): AsyncIterable<BundleExportSourceRow<T>> {
  if (isAsyncIterable<BundleExportSourceRow<T>>(rows)) {
    yield* rows;
    return;
  }
  yield* rows;
}

function readDiagnosticBatchDelayMs(): number {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(BUNDLE_EXPORT_BATCH_DELAY_KEY);
    const value = Number(raw || 0);
    return Number.isFinite(value) && value > 0 ? Math.min(1000, value) : 0;
  } catch {
    return 0;
  }
}

async function waitForDiagnosticBatchDelay(delayMs: number): Promise<void> {
  if (!delayMs) return;
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

export function exportCanonicalBundleZipWithWorker<T>({
  rows,
  totalRecords,
  options,
  onProgress,
  batchSize = BUNDLE_EXPORT_WORKER_BATCH_SIZE,
}: ExportBundleWithWorkerOptions<T>): BundleExportWorkerJob {
  const jobId = createJobId();
  const startedAt = nowMs();
  const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
  const diagnosticBatchDelayMs = readDiagnosticBatchDelayMs();
  let worker: Worker | null = null;
  let settled = false;
  let cancelled = false;
  let sentRows = 0;
  let sentBatches = 0;
  let rejectJob: ((error: Error) => void) | null = null;
  let resolveReady: (() => void) | null = null;
  let readyForChunk = false;

  const waitForReadyForChunk = () =>
    new Promise<void>((resolve, reject) => {
      if (cancelled || settled) {
        reject(new Error('Bundle export cancelled.'));
        return;
      }
      if (readyForChunk) {
        readyForChunk = false;
        resolve();
        return;
      }
      resolveReady = resolve;
    });

  const markSettled = () => {
    settled = true;
    resolveReady?.();
    resolveReady = null;
  };

  const postToWorker = (message: BundleExportWorkerRequest) => {
    if (!worker || settled || cancelled) return;
    worker.postMessage(message);
  };

  const promise = new Promise<string>((resolve, reject) => {
    rejectJob = reject;
    try {
      worker = new BundleExportWorkerCtor();
      setWorkerAvailability('export', true);
    } catch (error) {
      setWorkerAvailability('export', false);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    worker.onmessage = (event: MessageEvent<BundleExportWorkerResponse>) => {
      const message = event.data;
      if (!message || message.jobId !== jobId) return;

      if (message.type === 'bundle-export:ready-for-chunk') {
        if (resolveReady) {
          resolveReady();
          resolveReady = null;
        } else {
          readyForChunk = true;
        }
        return;
      }

      if (message.type === 'bundle-export:progress') {
        onProgress?.(message.progress);
        return;
      }

      markSettled();
      worker?.terminate();
      worker = null;

      if (message.type === 'bundle-export:error') {
        recordPerfMetric({
          kind: 'export',
          name: 'bundle-worker-error',
          durationMs: message.elapsedMs,
          tags: { error: message.error },
        });
        reject(new Error(message.error));
        return;
      }

      const blob = new Blob([message.buffer], { type: 'application/zip' });
      saveFile(message.filename, blob);
      recordPerfMetric({
        kind: 'export',
        name: 'bundle-worker-complete',
        durationMs: nowMs() - startedAt,
        value: message.buffer.byteLength,
        tags: {
          records: message.manifest.counts.records,
          compressionLevel: options.compressionLevel ?? 1,
          batches: sentBatches,
          sentRows,
        },
      });
      resolve(message.filename);
    };

    worker.onerror = (event) => {
      if (settled) return;
      markSettled();
      setWorkerAvailability('export', false);
      worker?.terminate();
      worker = null;
      reject(new Error(event.message || 'Bundle export worker failed.'));
    };

    postToWorker({
      type: 'bundle-export:start',
      jobId,
      totalRecords,
      options: {
        ...options,
        compressionLevel: options.compressionLevel ?? 1,
        totalRecords,
      },
    } satisfies BundleExportWorkerRequest);

    void (async () => {
      try {
        let batch: Array<BundleExportSourceRow<unknown>> = [];
        for await (const row of toAsyncRows(rows)) {
          if (cancelled || settled) return;
          batch.push(row as BundleExportSourceRow<unknown>);
          if (batch.length < normalizedBatchSize) {
            continue;
          }
          await waitForReadyForChunk();
          if (cancelled || settled) return;
          sentBatches += 1;
          sentRows += batch.length;
          postToWorker({ type: 'bundle-export:chunk', jobId, rows: batch });
          recordPerfMetric({
            kind: 'export',
            name: 'bundle-worker-batch-sent',
            value: batch.length,
            tags: { batch: sentBatches, sentRows, totalRecords },
          });
          batch = [];
          await waitForDiagnosticBatchDelay(diagnosticBatchDelayMs);
        }
        if (batch.length) {
          await waitForReadyForChunk();
          if (cancelled || settled) return;
          sentBatches += 1;
          sentRows += batch.length;
          postToWorker({ type: 'bundle-export:chunk', jobId, rows: batch });
          recordPerfMetric({
            kind: 'export',
            name: 'bundle-worker-batch-sent',
            value: batch.length,
            tags: { batch: sentBatches, sentRows, totalRecords },
          });
          await waitForDiagnosticBatchDelay(diagnosticBatchDelayMs);
        }
        await waitForReadyForChunk();
        if (cancelled || settled) return;
        postToWorker({ type: 'bundle-export:finish', jobId });
        recordPerfMetric({
          kind: 'export',
          name: 'bundle-worker-stream-complete',
          durationMs: nowMs() - startedAt,
          value: sentRows,
          tags: { batches: sentBatches, totalRecords },
        });
      } catch (error) {
        if (settled) return;
        markSettled();
        worker?.terminate();
        worker = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });

  return {
    jobId,
    promise,
    cancel: () => {
      if (settled || cancelled) return;
      cancelled = true;
      markSettled();
      worker?.postMessage({
        type: 'bundle-export:cancel',
        jobId,
      } satisfies BundleExportWorkerRequest);
      worker?.terminate();
      worker = null;
      rejectJob?.(new Error('Bundle export cancelled.'));
      recordPerfMetric({
        kind: 'export',
        name: 'bundle-worker-cancel',
        durationMs: nowMs() - startedAt,
        value: sentRows,
        tags: { batches: sentBatches },
      });
    },
  };
}
