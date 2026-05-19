import packageJson from '@/../package.json';
import {
  BundleManifest,
  BundleRecordEnvelope,
  ImportedBundle,
  ImportedBundleCollection,
  ImportedBundleImportReport,
  ImportedBundleItem,
  ImportedEntitySnapshot,
} from './schema';
import { decodeBundleTextEntry, readBundleZip } from './zip';
import { validateBundleManifest, validateBundleRecordEnvelope } from './validation';

export interface BundleImportDatabase {
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

export interface BundleImportResult {
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

function parseJsonLine(line: string, lineNumber: number): BundleRecordEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as BundleRecordEnvelope;
  } catch (error) {
    throw new Error(`Invalid JSONL at records line ${lineNumber}: ${getErrorMessage(error)}`);
  }
}

function extractSearchText(record: BundleRecordEnvelope): string {
  const parts: string[] = [];
  const data = record.data as Record<string, unknown>;
  for (const key of ['full_text', 'text', 'description', 'name', 'screen_name']) {
    const value = data?.[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(value);
    }
  }
  if (!parts.length) {
    parts.push(JSON.stringify(record.data).slice(0, 20000));
  }
  return parts.join('\n');
}

function buildImportedBundle(manifest: BundleManifest, now: number): ImportedBundle {
  return {
    id: manifest.id,
    title: manifest.title,
    description: manifest.description,
    status: 'importing',
    visibility: manifest.privacy.visibility,
    importedAt: now,
    updatedAt: now,
    schemaVersion: manifest.producer.schemaVersion,
    appVersion: manifest.producer.appVersion,
    recordCount: manifest.counts.records,
    mediaBlobCount: manifest.counts.mediaBlobs,
    manifest,
  };
}

export async function importBundleZip(
  database: BundleImportDatabase,
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<BundleImportResult> {
  const now = Date.now();
  const { entries } = await readBundleZip(data);
  const manifest = JSON.parse(decodeBundleTextEntry(entries, 'manifest.json')) as BundleManifest;
  const manifestValidation = validateBundleManifest(manifest);
  if (!manifestValidation.ok) {
    throw new Error(
      `Invalid bundle manifest: ${manifestValidation.issues[0]?.message ?? 'unknown error'}`,
    );
  }

  const recordsPath =
    manifest.files.find((file) => file.role === 'records')?.path ??
    [...entries.keys()].find((path) => path.endsWith('.jsonl'));
  if (!recordsPath) {
    throw new Error('Bundle is missing a records JSONL file.');
  }

  const reportId = `${manifest.id}:import:${now}`;
  const recordsText = decodeBundleTextEntry(entries, recordsPath);
  const defaultCollection: ImportedBundleCollection = {
    id: `${manifest.id}:all`,
    bundle_id: manifest.id,
    name: 'All Records',
    kind: 'mixed',
    record_count: 0,
    created_at: now,
    updated_at: now,
  };

  const snapshots: ImportedEntitySnapshot[] = [];
  const items: ImportedBundleItem[] = [];
  const warnings: string[] = [];
  let recordsSeen = 0;
  let recordsSkipped = 0;

  const lines = recordsText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const record = parseJsonLine(lines[index] ?? '', index + 1);
    if (!record) {
      continue;
    }

    recordsSeen += 1;
    const validation = validateBundleRecordEnvelope(record);
    if (!validation.ok) {
      recordsSkipped += 1;
      warnings.push(
        `Skipped line ${index + 1}: ${validation.issues[0]?.message ?? 'invalid record'}`,
      );
      continue;
    }

    const snapshotId = `${manifest.id}:${record.id}`;
    snapshots.push({
      id: snapshotId,
      bundle_id: manifest.id,
      kind: record.kind,
      source_id: record.sourceId,
      source_extension: record.sourceExtension,
      observed_at: record.observedAt,
      sensitivity: record.sensitivity,
      data: record.data,
      media_refs: record.mediaRefs,
      search_text: extractSearchText(record),
      created_at: now,
      updated_at: now,
    });
    items.push({
      id: `${defaultCollection.id}:${record.id}`,
      bundle_id: manifest.id,
      collection_id: defaultCollection.id,
      record_id: snapshotId,
      kind: record.kind,
      source_id: record.sourceId,
      sort_time: record.observedAt,
      created_at: now,
    });
  }

  defaultCollection.record_count = items.length;

  const report: ImportedBundleImportReport = {
    id: reportId,
    bundle_id: manifest.id,
    started_at: now,
    finished_at: Date.now(),
    status: 'ok',
    records_seen: recordsSeen,
    records_imported: snapshots.length,
    records_skipped: recordsSkipped,
    warnings,
  };

  try {
    await database.bundlePutImportBatch({
      bundle: buildImportedBundle(
        {
          ...manifest,
          producer: {
            ...manifest.producer,
            appVersion: manifest.producer.appVersion || packageJson.version,
          },
        },
        now,
      ),
      collections: [defaultCollection],
      items,
      snapshots,
      report,
    });
    await database.bundleMarkReady(manifest.id);
  } catch (error) {
    await database.bundleMarkFailed(manifest.id, getErrorMessage(error));
    throw error;
  }

  return {
    bundleId: manifest.id,
    recordsSeen,
    recordsImported: snapshots.length,
    recordsSkipped,
    warnings,
  };
}
