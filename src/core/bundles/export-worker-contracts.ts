import type { BundleExportOptions, BundleExportProgress, BundleExportSourceRow } from './exporter';
import type { BundleManifest } from './schema';

export type BundleExportWorkerRequest =
  | {
      type: 'bundle-export:start';
      jobId: string;
      options: Omit<BundleExportOptions, 'onProgress'>;
      totalRecords: number;
    }
  | {
      type: 'bundle-export:chunk';
      jobId: string;
      rows: Array<BundleExportSourceRow<unknown>>;
    }
  | {
      type: 'bundle-export:finish';
      jobId: string;
    }
  | {
      type: 'bundle-export:cancel';
      jobId: string;
    };

export type BundleExportWorkerResponse =
  | {
      type: 'bundle-export:ready-for-chunk';
      jobId: string;
    }
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
