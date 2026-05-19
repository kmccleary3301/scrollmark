import type { BundleExportOptions, BundleExportProgress, BundleExportSourceRow } from './exporter';
import type { BundleManifest } from './schema';

export type BundleExportWorkerRequest =
  | {
      type: 'bundle-export:start';
      jobId: string;
      rows: Array<BundleExportSourceRow<unknown>>;
      options: Omit<BundleExportOptions, 'onProgress'>;
    }
  | {
      type: 'bundle-export:cancel';
      jobId: string;
    };

export type BundleExportWorkerResponse =
  | {
      type: 'bundle-export:progress';
      jobId: string;
      progress: BundleExportProgress;
    }
  | {
      type: 'bundle-export:done';
      jobId: string;
      filename: string;
      buffer: ArrayBuffer;
      manifest: BundleManifest;
      elapsedMs: number;
    }
  | {
      type: 'bundle-export:error';
      jobId: string;
      error: string;
      elapsedMs: number;
    };
