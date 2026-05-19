import fs from 'node:fs';
import path from 'node:path';

import { createCanonicalBundleZip, type BundleExportSourceRow } from '@/core/bundles/exporter';
import { importBundleZip, type BundleImportDatabase } from '@/core/bundles/importer';
import type {
  ImportedBundle,
  ImportedBundleCollection,
  ImportedBundleImportReport,
  ImportedBundleItem,
  ImportedEntitySnapshot,
} from '@/core/bundles/schema';
import type { DataType } from '@/utils/exporter';

const [recordsPath, outPath] = process.argv.slice(2);
if (!recordsPath || !outPath) {
  console.error(
    'usage: tsx e2e/bundles/canonical_bundle_roundtrip_harness.ts <records.json> <out.json>',
  );
  process.exit(2);
}

type FakeDbState = {
  bundles: ImportedBundle[];
  collections: ImportedBundleCollection[];
  items: ImportedBundleItem[];
  snapshots: ImportedEntitySnapshot[];
  reports: ImportedBundleImportReport[];
  ready: string[];
  failed: Array<{ bundleId: string; error: string }>;
};

class FakeBundleDatabase implements BundleImportDatabase {
  state: FakeDbState = {
    bundles: [],
    collections: [],
    items: [],
    snapshots: [],
    reports: [],
    ready: [],
    failed: [],
  };

  async bundlePutImportBatch(args: {
    bundle: ImportedBundle;
    collections?: ImportedBundleCollection[];
    items?: ImportedBundleItem[];
    snapshots?: ImportedEntitySnapshot[];
    report?: ImportedBundleImportReport;
  }): Promise<void> {
    this.state.bundles.push(args.bundle);
    this.state.collections.push(...(args.collections || []));
    this.state.items.push(...(args.items || []));
    this.state.snapshots.push(...(args.snapshots || []));
    if (args.report) {
      this.state.reports.push(args.report);
    }
  }

  async bundleMarkReady(bundleId: string): Promise<void> {
    this.state.ready.push(bundleId);
  }

  async bundleMarkFailed(bundleId: string, error: string): Promise<void> {
    this.state.failed.push({ bundleId, error });
  }
}

const sourceRecords = JSON.parse(fs.readFileSync(path.resolve(recordsPath), 'utf8')) as Array<
  Record<string, unknown>
>;
const sample = sourceRecords.slice(0, 250);
const rows: Array<BundleExportSourceRow<Record<string, unknown>>> = sample.map((record, index) => {
  const legacy = (record.legacy || {}) as Record<string, unknown>;
  const core = (record.core || {}) as Record<string, unknown>;
  const userResults = (core.user_results || {}) as Record<string, unknown>;
  const userResult = (userResults.result || {}) as Record<string, unknown>;
  const userCore = (userResult.core || {}) as Record<string, unknown>;
  const data: DataType = {
    id: String(record.rest_id || index),
    rest_id: String(record.rest_id || index),
    full_text: legacy.full_text ?? legacy.text ?? '',
    created_at: legacy.created_at ?? '',
    screen_name: userCore.screen_name ?? '',
    profile_name: userCore.name ?? '',
    bookmark_folder_id: record.__bookmark_folder_id ?? null,
    bookmark_folder_name: record.__bookmark_folder_name ?? null,
  };
  return {
    id: String(record.rest_id || index),
    original: record,
    record: data,
  };
});

const exported = await createCanonicalBundleZip(rows, {
  title: 'Canonical Bundle Roundtrip Harness',
  scope: 'result_set',
  compressionLevel: 1,
  includeOriginalMetadata: true,
});
const fakeDb = new FakeBundleDatabase();
const imported = await importBundleZip(fakeDb, exported.bytes);
const searchableFailures = fakeDb.state.snapshots.filter(
  (snapshot) => !snapshot.search_text?.trim(),
);
const payload = {
  ok:
    imported.recordsImported === rows.length &&
    fakeDb.state.ready.length === 1 &&
    fakeDb.state.failed.length === 0 &&
    searchableFailures.length === 0,
  source_records: sourceRecords.length,
  sampled_records: rows.length,
  zip_bytes: exported.bytes.byteLength,
  import_result: imported,
  fake_db_counts: {
    bundles: fakeDb.state.bundles.length,
    collections: fakeDb.state.collections.length,
    items: fakeDb.state.items.length,
    snapshots: fakeDb.state.snapshots.length,
    reports: fakeDb.state.reports.length,
    ready: fakeDb.state.ready.length,
    failed: fakeDb.state.failed.length,
  },
  searchable_failures: searchableFailures.slice(0, 5).map((snapshot) => snapshot.id),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));

if (!payload.ok) {
  process.exit(1);
}
