import packageJson from '@/../package.json';
import { DataType } from '@/utils/exporter';
import { createBundleId, createBundleRecordId } from './ids';
import { buildBundlePrivacySummary, SAFE_SHARED_DEFAULT_PRIVACY } from './privacy';
import {
  BundleManifest,
  BundleRecordEnvelope,
  ImportedBundle,
  ImportedBundleCollection,
  ImportedBundleImportReport,
  ImportedBundleItem,
  ImportedEntitySnapshot,
} from './schema';

export interface LegacyImportDatabase {
  bundlePutImportBatch(args: {
    bundle: ImportedBundle;
    collections?: ImportedBundleCollection[];
    items?: ImportedBundleItem[];
    snapshots?: ImportedEntitySnapshot[];
    report?: ImportedBundleImportReport;
  }): Promise<void>;
  bundleMarkReady(bundleId: string): Promise<void>;
  bundleMarkFailed(bundleId: string, error: string): Promise<void>;
}

export interface LegacyImportResult {
  bundleId: string;
  recordsSeen: number;
  recordsImported: number;
  recordsSkipped: number;
  warnings: string[];
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

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function inferKind(value: Record<string, unknown>) {
  if (value.metadata && isObject(value.metadata)) {
    return inferKind(value.metadata);
  }
  const typename = String(value.__typename || '').toLowerCase();
  if (typename.includes('tweet') || value.full_text || value.media || value.bookmark_folder_id)
    return 'tweet';
  if (typename.includes('user') || value.screen_name || value.profile_image_url) return 'user';
  return 'unknown';
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

function inferSourceId(value: Record<string, unknown>, fallback: number): string {
  if (value.metadata && isObject(value.metadata)) {
    return inferSourceId(value.metadata, fallback);
  }
  return String(value.rest_id || value.id || value.user_id || value.tweet_id || fallback);
}

function inferObservedAt(value: Record<string, unknown>): number | undefined {
  const metadata = isObject(value.metadata) ? value.metadata : null;
  const privateFields = isObject(metadata?.twe_private_fields)
    ? metadata.twe_private_fields
    : isObject(value.twe_private_fields)
      ? value.twe_private_fields
      : null;
  const candidates = [
    privateFields?.created_at,
    privateFields?.updated_at,
    value.created_at,
    value.date,
    value.time,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function extractRowsFromJson(value: unknown): DataType[] {
  if (Array.isArray(value)) {
    return value.filter(isObject) as DataType[];
  }
  if (!isObject(value)) {
    return [];
  }
  if (Array.isArray(value.records)) {
    return value.records.filter(isObject) as DataType[];
  }
  if (Array.isArray(value.data)) {
    return value.data.filter(isObject) as DataType[];
  }
  if (Array.isArray(value.rows)) {
    return value.rows.filter(isObject) as DataType[];
  }
  return [value as DataType];
}

function parseLegacyText(text: string, filename: string): DataType[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (filename.endsWith('.jsonl') || trimmed.includes('\n{')) {
    const rows: DataType[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const part = line.trim();
      if (!part) continue;
      const parsed = JSON.parse(part) as unknown;
      if (isObject(parsed)) rows.push(parsed as DataType);
    }
    if (rows.length) return rows;
  }
  return extractRowsFromJson(JSON.parse(trimmed) as unknown);
}

async function createLegacyEnvelope(bundleId: string, row: DataType, index: number) {
  const kind = inferKind(row);
  const sourceId = inferSourceId(row, index);
  const id = await createBundleRecordId(bundleId, kind, sourceId);
  return {
    id,
    kind,
    sourceId,
    observedAt: inferObservedAt(row),
    sensitivity: 'low',
    data: row,
    mediaRefs: Array.isArray(row.media)
      ? row.media.map((media: Record<string, unknown>, mediaIndex: number) => ({
          id: `${id}:media:${mediaIndex}`,
          type:
            media.type === 'photo' || media.type === 'video' || media.type === 'animated_gif'
              ? media.type
              : 'unknown',
          url: safeHttpUrl(media.original),
          previewUrl: safeHttpUrl(media.thumbnail),
          altText: typeof media.ext_alt_text === 'string' ? media.ext_alt_text : undefined,
        }))
      : undefined,
  } satisfies BundleRecordEnvelope;
}

export async function importLegacyBundleFile(
  database: LegacyImportDatabase,
  file: File,
): Promise<LegacyImportResult> {
  const now = Date.now();
  const text = await file.text();
  const rows = parseLegacyText(text, file.name);
  const bundleId = await createBundleId(`legacy:${file.name}:${file.size}:${now}`);
  const records = await Promise.all(
    rows.map((row, index) => createLegacyEnvelope(bundleId, row, index)),
  );
  const privacy = buildBundlePrivacySummary({
    ...SAFE_SHARED_DEFAULT_PRIVACY,
    includeSourceCaptureTimes: true,
  });
  const manifest: BundleManifest = {
    id: bundleId,
    title: file.name.replace(/\.(json|jsonl)$/i, ''),
    description: `Imported from legacy ${file.name}`,
    producer: {
      app: 'twitter-web-exporter',
      appVersion: packageJson.version,
      schemaVersion: 1,
      exportedAt: now,
    },
    privacy,
    counts: {
      records: records.length,
      tweets: records.filter((record) => record.kind === 'tweet').length,
      users: records.filter((record) => record.kind === 'user').length,
      socialEdges: 0,
      captures: 0,
      mediaBlobs: 0,
    },
    files: [
      {
        path: file.name,
        contentType: file.name.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json',
        role: 'records',
        bytes: file.size,
      },
    ],
  };

  const collection: ImportedBundleCollection = {
    id: `${bundleId}:all`,
    bundle_id: bundleId,
    name: 'All Records',
    kind: 'mixed',
    record_count: records.length,
    created_at: now,
    updated_at: now,
  };
  const snapshots: ImportedEntitySnapshot[] = records.map((record) => ({
    id: `${bundleId}:${record.id}`,
    bundle_id: bundleId,
    kind: record.kind,
    source_id: record.sourceId,
    observed_at: record.observedAt,
    sensitivity: record.sensitivity,
    data: record.data,
    media_refs: record.mediaRefs,
    search_text: JSON.stringify(record.data).slice(0, 20000),
    created_at: now,
    updated_at: now,
  }));
  const items: ImportedBundleItem[] = snapshots.map((snapshot) => ({
    id: `${collection.id}:${snapshot.id}`,
    bundle_id: bundleId,
    collection_id: collection.id,
    record_id: snapshot.id,
    kind: snapshot.kind,
    source_id: snapshot.source_id,
    sort_time: snapshot.observed_at,
    created_at: now,
  }));
  const report: ImportedBundleImportReport = {
    id: `${bundleId}:import:${now}`,
    bundle_id: bundleId,
    started_at: now,
    finished_at: Date.now(),
    status: 'ok',
    records_seen: rows.length,
    records_imported: snapshots.length,
    records_skipped: rows.length - snapshots.length,
    warnings: ['Imported through legacy JSON/JSONL compatibility path.'],
  };

  try {
    await database.bundlePutImportBatch({
      bundle: {
        id: bundleId,
        title: manifest.title,
        description: manifest.description,
        status: 'importing',
        visibility: manifest.privacy.visibility,
        importedAt: now,
        updatedAt: now,
        schemaVersion: manifest.producer.schemaVersion,
        appVersion: packageJson.version,
        recordCount: snapshots.length,
        mediaBlobCount: 0,
        manifest,
      },
      collections: [collection],
      items,
      snapshots,
      report,
    });
    await database.bundleMarkReady(bundleId);
  } catch (error) {
    await database.bundleMarkFailed(bundleId, getErrorMessage(error));
    throw error;
  }

  return {
    bundleId,
    recordsSeen: rows.length,
    recordsImported: snapshots.length,
    recordsSkipped: rows.length - snapshots.length,
    warnings: report.warnings,
  };
}
