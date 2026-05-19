import { createCanonicalBundleZip } from './exporter';
import type {
  BundleExportWorkerRequest,
  BundleExportWorkerResponse,
} from './export-worker-contracts';

const cancelledJobs = new Set<string>();

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function post(message: BundleExportWorkerResponse, transfer?: Transferable[]): void {
  self.postMessage(message, { transfer: transfer || [] });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

self.onmessage = (event: MessageEvent<BundleExportWorkerRequest>) => {
  const request = event.data;
  if (!request || typeof request !== 'object') return;

  if (request.type === 'bundle-export:cancel') {
    cancelledJobs.add(request.jobId);
    return;
  }

  if (request.type !== 'bundle-export:start') return;

  const startedAt = nowMs();
  void (async () => {
    try {
      if (cancelledJobs.has(request.jobId)) {
        cancelledJobs.delete(request.jobId);
        return;
      }
      const result = await createCanonicalBundleZip(request.rows, {
        ...request.options,
        onProgress: (progress) => {
          if (cancelledJobs.has(request.jobId)) {
            throw new Error('Bundle export cancelled.');
          }
          post({ type: 'bundle-export:progress', jobId: request.jobId, progress });
        },
      });
      if (cancelledJobs.has(request.jobId)) {
        cancelledJobs.delete(request.jobId);
        return;
      }
      const buffer = result.bytes.buffer.slice(
        result.bytes.byteOffset,
        result.bytes.byteOffset + result.bytes.byteLength,
      ) as ArrayBuffer;
      post(
        {
          type: 'bundle-export:done',
          jobId: request.jobId,
          filename: result.filename,
          buffer,
          manifest: result.manifest,
          elapsedMs: nowMs() - startedAt,
        },
        [buffer],
      );
    } catch (error) {
      post({
        type: 'bundle-export:error',
        jobId: request.jobId,
        error: errorMessage(error),
        elapsedMs: nowMs() - startedAt,
      });
    } finally {
      cancelledJobs.delete(request.jobId);
    }
  })();
};
