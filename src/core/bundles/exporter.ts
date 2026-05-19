import packageJson from '@/../package.json';
import type { DataType } from '@/utils/exporter';
import { createBundleId, createBundleRecordId, sha256Hex } from './ids';
import { buildBundlePrivacySummary, SAFE_SHARED_DEFAULT_PRIVACY } from './privacy';
import {
  BundleEntityKind,
  BundleFileManifestEntry,
  BundleManifest,
  BundleManifestCounts,
  BundleRecordEnvelope,
} from './schema';
import { createBundleZip } from './zip';

export interface BundleExportSourceRow<T = unknown> {
  id: string;
  original: T;
  record: DataType;
}

export interface BundleExportOptions {
  title: string;
  description?: string;
  scope: 'selected' | 'result_set' | 'bundle';
  queryText?: string;
  sort?: string;
  includeOriginalMetadata?: boolean;
  compressionLevel?: 0 | 1 | 6;
  onProgress?: (progress: BundleExportProgress) => void;
}

export type BundleExportProgress = {
  phase: 'envelope' | 'manifest' | 'zip' | 'done';
  processedRecords: number;
  totalRecords: number;
  elapsedMs: number;
};

function normalizeFilename(value: string): string {
  return (
    String(value || 'bundle')
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'bundle'
  );
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function inferKind(original: unknown, record: DataType): BundleEntityKind {
  const source =
    original && typeof original === 'object' ? (original as Record<string, unknown>) : {};
  const typename = String(source.__typename || record.__typename || '').toLowerCase();
  if (typename.includes('tweet') || record.full_text || record.media) return 'tweet';
  if (typename.includes('user') || record.screen_name || record.profile_image_url) return 'user';
  return 'unknown';
}

function extractObservedAt(original: unknown, record: DataType): number | undefined {
  const source =
    original && typeof original === 'object' ? (original as Record<string, unknown>) : {};
  const privateFields = source.twe_private_fields as Record<string, unknown> | undefined;
  const candidates = [
    privateFields?.created_at,
    privateFields?.updated_at,
    record.created_at,
    record.time,
    record.date,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

async function buildRecordEnvelope<T>(
  bundleId: string,
  row: BundleExportSourceRow<T>,
  options: BundleExportOptions,
): Promise<BundleRecordEnvelope> {
  const kind = inferKind(row.original, row.record);
  const sourceId = String(row.id || row.record.id || row.record.rest_id || '');
  const id = await createBundleRecordId(bundleId, kind, sourceId || JSON.stringify(row.record));
  const data = options.includeOriginalMetadata
    ? {
        ...row.record,
        metadata: row.original,
      }
    : row.record;

  return {
    id,
    kind,
    sourceId: sourceId || undefined,
    observedAt: extractObservedAt(row.original, row.record),
    sensitivity: 'low',
    data,
    mediaRefs: Array.isArray(row.record.media)
      ? row.record.media.map((media: Record<string, unknown>, index: number) => ({
          id: `${id}:media:${index}`,
          type:
            media.type === 'photo' || media.type === 'video' || media.type === 'animated_gif'
              ? media.type
              : 'unknown',
          url: safeHttpUrl(media.original),
          previewUrl: safeHttpUrl(media.thumbnail),
          altText: typeof media.ext_alt_text === 'string' ? media.ext_alt_text : undefined,
        }))
      : undefined,
  };
}

function countBundleRecords(records: BundleRecordEnvelope[]): BundleManifestCounts {
  return records.reduce<BundleManifestCounts>(
    (acc, record) => {
      acc.records += 1;
      if (record.kind === 'tweet') acc.tweets += 1;
      if (record.kind === 'user') acc.users += 1;
      if (record.kind === 'social_edge') acc.socialEdges += 1;
      if (record.kind === 'capture') acc.captures += 1;
      acc.mediaBlobs += 0;
      return acc;
    },
    { records: 0, tweets: 0, users: 0, socialEdges: 0, captures: 0, mediaBlobs: 0 },
  );
}

export async function createCanonicalBundleZip<T>(
  rows: Array<BundleExportSourceRow<T>>,
  options: BundleExportOptions,
): Promise<{ filename: string; bytes: Uint8Array; manifest: BundleManifest }> {
  const now = Date.now();
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const reportProgress = (phase: BundleExportProgress['phase'], processedRecords: number) => {
    options.onProgress?.({
      phase,
      processedRecords,
      totalRecords: rows.length,
      elapsedMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
    });
  };
  const bundleId = await createBundleId(
    `${options.title}:${options.scope}:${options.queryText || ''}:${now}:${rows.length}`,
  );
  const records: BundleRecordEnvelope[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    records.push(await buildRecordEnvelope(bundleId, row, options));
    if (index === 0 || index + 1 === rows.length || (index + 1) % 100 === 0) {
      reportProgress('envelope', index + 1);
    }
  }
  const recordsJsonl = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const privacy = buildBundlePrivacySummary(SAFE_SHARED_DEFAULT_PRIVACY);
  const files: BundleFileManifestEntry[] = [
    {
      path: 'manifest.json',
      contentType: 'application/json',
      role: 'manifest',
    },
    {
      path: 'records/records.jsonl',
      contentType: 'application/x-ndjson',
      role: 'records',
      bytes: new TextEncoder().encode(recordsJsonl).byteLength,
      sha256: await sha256Hex(recordsJsonl),
    },
  ];

  const mediaUrlLines = records
    .flatMap((record) => record.mediaRefs || [])
    .map((media) => media.url)
    .filter((url): url is string => !!url);
  const mediaUrlsText = mediaUrlLines.join('\n') + (mediaUrlLines.length ? '\n' : '');
  if (mediaUrlLines.length) {
    files.push({
      path: 'media/media-urls.txt',
      contentType: 'text/plain',
      role: 'media',
      bytes: new TextEncoder().encode(mediaUrlsText).byteLength,
      sha256: await sha256Hex(mediaUrlsText),
    });
  }

  const manifest: BundleManifest = {
    id: bundleId,
    title: options.title,
    description: options.description,
    producer: {
      app: 'twitter-web-exporter',
      appVersion: packageJson.version,
      schemaVersion: 1,
      exportedAt: now,
    },
    privacy,
    counts: countBundleRecords(records),
    files,
  };

  const manifestFile = files[0];
  if (manifestFile) {
    files[0] = {
      ...manifestFile,
      bytes: new TextEncoder().encode(JSON.stringify(manifest, undefined, 2)).byteLength,
    };
  }
  reportProgress('manifest', records.length);

  const compressionLevel = options.compressionLevel ?? 1;
  const entries = [
    {
      path: 'manifest.json',
      data: JSON.stringify(manifest, undefined, 2),
      level: compressionLevel,
    },
    {
      path: 'records/records.jsonl',
      data: recordsJsonl,
      level: compressionLevel,
    },
  ];
  if (mediaUrlLines.length) {
    entries.push({ path: 'media/media-urls.txt', data: mediaUrlsText, level: compressionLevel });
  }
  reportProgress('zip', records.length);

  const result = {
    filename: `twe-bundle-${normalizeFilename(options.title)}-${now}.zip`,
    bytes: createBundleZip(entries),
    manifest,
  };
  reportProgress('done', records.length);
  return result;
}

export async function exportCanonicalBundleZip<T>(
  rows: Array<BundleExportSourceRow<T>>,
  options: BundleExportOptions,
) {
  const { filename, bytes } = await createCanonicalBundleZip(rows, options);
  const blobBytes = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const { saveFile } = await import('@/utils/exporter');
  saveFile(filename, new Blob([blobBytes], { type: 'application/zip' }));
  return filename;
}
