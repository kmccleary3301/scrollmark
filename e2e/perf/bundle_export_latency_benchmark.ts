import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createCanonicalBundleZip, type BundleExportSourceRow } from '@/core/bundles/exporter';
import { decodeBundleTextEntry, readBundleZip } from '@/core/bundles/zip';
import type { DataType } from '@/utils/exporter';

const [recordsPath, outPath] = process.argv.slice(2);
if (!recordsPath || !outPath) {
  console.error('usage: tsx e2e/perf/bundle_export_latency_benchmark.ts <records.json> <out.json>');
  process.exit(2);
}

const records = JSON.parse(fs.readFileSync(path.resolve(recordsPath), 'utf8')) as Array<
  Record<string, unknown>
>;
const rows: Array<BundleExportSourceRow<Record<string, unknown>>> = records.map((record, index) => {
  const legacy = (record.legacy || {}) as Record<string, unknown>;
  const core = (record.core || {}) as Record<string, unknown>;
  const userResults = (core.user_results || {}) as Record<string, unknown>;
  const userResult = (userResults.result || {}) as Record<string, unknown>;
  const userCore = (userResult.core || {}) as Record<string, unknown>;
  const exported: DataType = {
    id: String(record.rest_id || index),
    rest_id: String(record.rest_id || index),
    full_text: legacy.full_text ?? legacy.text ?? '',
    created_at: legacy.created_at ?? '',
    screen_name: userCore.screen_name ?? '',
    profile_name: userCore.name ?? '',
    favorite_count: legacy.favorite_count ?? 0,
    retweet_count: legacy.retweet_count ?? 0,
    reply_count: legacy.reply_count ?? 0,
    bookmark_count: legacy.bookmark_count ?? 0,
    bookmark_folder_id: record.__bookmark_folder_id ?? null,
    bookmark_folder_name: record.__bookmark_folder_name ?? null,
  };
  return {
    id: String(record.rest_id || index),
    original: record,
    record: exported,
  };
});

const progressEvents: Array<{
  phase: string;
  processedRecords: number;
  elapsedMs: number;
}> = [];
const startedAt = performance.now();
const result = await createCanonicalBundleZip(rows, {
  title: 'Final Hill Synthetic Benchmark',
  scope: 'result_set',
  compressionLevel: 1,
  includeOriginalMetadata: false,
  onProgress: (progress) => {
    progressEvents.push({
      phase: progress.phase,
      processedRecords: progress.processedRecords,
      elapsedMs: Number(progress.elapsedMs.toFixed(3)),
    });
  },
});
const elapsedMs = performance.now() - startedAt;
const zipRead = await readBundleZip(result.bytes);
const manifest = JSON.parse(decodeBundleTextEntry(zipRead.entries, 'manifest.json')) as {
  counts?: { records?: number };
};

const payload = {
  ok: manifest.counts?.records === records.length,
  records: records.length,
  elapsed_ms: Number(elapsedMs.toFixed(3)),
  zip_bytes: result.bytes.byteLength,
  manifest_records: manifest.counts?.records ?? null,
  progress_events: progressEvents,
  gates: {
    output_validates: manifest.counts?.records === records.length,
    worker_responsiveness_requires_browser_gate:
      'This benchmark validates bundle serialization/ZIP correctness; browser worker responsiveness is covered by the install/QC runbook and CDP smoke tooling.',
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
