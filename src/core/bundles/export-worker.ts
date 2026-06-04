import { createCanonicalBundleZipFromRows, type BundleExportSourceRow } from './exporter';
import type {
  BundleExportWorkerRequest,
  BundleExportWorkerResponse,
} from './export-worker-contracts';

type WorkerJobState = {
  jobId: string;
  startedAt: number;
  rows: Array<BundleExportSourceRow<unknown>>;
  finished: boolean;
  cancelled: boolean;
  waitingForChunk: boolean;
  wake: (() => void) | null;
};

const jobs = new Map<string, WorkerJobState>();

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

function wakeJob(job: WorkerJobState): void {
  job.wake?.();
  job.wake = null;
}

async function waitForRows(job: WorkerJobState): Promise<void> {
  if (job.rows.length || job.finished || job.cancelled) return;
  if (!job.waitingForChunk) {
    job.waitingForChunk = true;
    post({ type: 'bundle-export:ready-for-chunk', jobId: job.jobId });
  }
  await new Promise<void>((resolve) => {
    job.wake = resolve;
  });
}

async function* streamJobRows(job: WorkerJobState): AsyncIterable<BundleExportSourceRow<unknown>> {
  while (true) {
    await waitForRows(job);
    if (job.cancelled) {
      throw new Error('Bundle export cancelled.');
    }
    const next = job.rows.shift();
    if (next) {
      yield next;
      continue;
    }
    if (job.finished) {
      return;
    }
  }
}

async function runJob(
  job: WorkerJobState,
  request: Extract<BundleExportWorkerRequest, { type: 'bundle-export:start' }>,
): Promise<void> {
  try {
    const result = await createCanonicalBundleZipFromRows(streamJobRows(job), {
      ...request.options,
      totalRecords: request.totalRecords,
      onProgress: (progress) => {
        if (job.cancelled) {
          throw new Error('Bundle export cancelled.');
        }
        post({ type: 'bundle-export:progress', jobId: request.jobId, progress });
      },
    });
    if (job.cancelled) {
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
        elapsedMs: nowMs() - job.startedAt,
      },
      [buffer],
    );
  } catch (error) {
    if (!job.cancelled) {
      post({
        type: 'bundle-export:error',
        jobId: request.jobId,
        error: errorMessage(error),
        elapsedMs: nowMs() - job.startedAt,
      });
    }
  } finally {
    jobs.delete(request.jobId);
  }
}

self.onmessage = (event: MessageEvent<BundleExportWorkerRequest>) => {
  const request = event.data;
  if (!request || typeof request !== 'object') return;

  if (request.type === 'bundle-export:start') {
    const existing = jobs.get(request.jobId);
    if (existing) {
      existing.cancelled = true;
      wakeJob(existing);
      jobs.delete(request.jobId);
    }
    const job: WorkerJobState = {
      jobId: request.jobId,
      startedAt: nowMs(),
      rows: [],
      finished: false,
      cancelled: false,
      waitingForChunk: false,
      wake: null,
    };
    jobs.set(request.jobId, job);
    void runJob(job, request);
    return;
  }

  const job = jobs.get(request.jobId);
  if (!job) return;

  if (request.type === 'bundle-export:chunk') {
    if (!job.finished && !job.cancelled) {
      job.rows.push(...request.rows);
      job.waitingForChunk = false;
      wakeJob(job);
    }
    return;
  }

  if (request.type === 'bundle-export:finish') {
    job.finished = true;
    wakeJob(job);
    return;
  }

  if (request.type === 'bundle-export:cancel') {
    job.cancelled = true;
    wakeJob(job);
  }
};
