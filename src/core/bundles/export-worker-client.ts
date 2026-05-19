import BundleExportWorkerCtor from './export-worker?worker&inline';
import { nowMs, recordPerfMetric, setWorkerAvailability } from '@/core/perf/metrics';
import { saveFile } from '@/utils/exporter';
import type { BundleExportOptions, BundleExportProgress, BundleExportSourceRow } from './exporter';
import type {
  BundleExportWorkerRequest,
  BundleExportWorkerResponse,
} from './export-worker-contracts';

function createJobId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `bundle-${crypto.randomUUID()}`;
  }
  return `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type ExportBundleWithWorkerOptions<T> = {
  rows: Array<BundleExportSourceRow<T>>;
  options: Omit<BundleExportOptions, 'onProgress'>;
  onProgress?: (progress: BundleExportProgress) => void;
};

export type BundleExportWorkerJob = {
  jobId: string;
  promise: Promise<string>;
  cancel: () => void;
};

export function exportCanonicalBundleZipWithWorker<T>({
  rows,
  options,
  onProgress,
}: ExportBundleWithWorkerOptions<T>): BundleExportWorkerJob {
  const jobId = createJobId();
  const startedAt = nowMs();
  let worker: Worker | null = null;
  let settled = false;
  let rejectJob: ((error: Error) => void) | null = null;

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

      if (message.type === 'bundle-export:progress') {
        onProgress?.(message.progress);
        return;
      }

      settled = true;
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
        },
      });
      resolve(message.filename);
    };

    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      setWorkerAvailability('export', false);
      worker?.terminate();
      worker = null;
      reject(new Error(event.message || 'Bundle export worker failed.'));
    };

    worker.postMessage({
      type: 'bundle-export:start',
      jobId,
      rows: rows as Array<BundleExportSourceRow<unknown>>,
      options: {
        ...options,
        compressionLevel: options.compressionLevel ?? 1,
      },
    } satisfies BundleExportWorkerRequest);
  });

  return {
    jobId,
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
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
      });
    },
  };
}
