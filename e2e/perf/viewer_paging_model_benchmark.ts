import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const [recordsPath, outPath] = process.argv.slice(2);
if (!recordsPath || !outPath) {
  console.error('usage: tsx e2e/perf/viewer_paging_model_benchmark.ts <records.json> <out.json>');
  process.exit(2);
}

const records = JSON.parse(fs.readFileSync(path.resolve(recordsPath), 'utf8')) as Array<
  Record<string, unknown>
>;

const initialPageSize = 160;
const nextPageSize = 320;
const startedAt = performance.now();
const ids = records.map((record, index) => String(record.rest_id || index));
const firstPageIds = ids.slice(0, initialPageSize);
const secondPageIds = ids.slice(initialPageSize, initialPageSize + nextPageSize);
const firstPageRecords = firstPageIds
  .map((id) => records.find((record) => String(record.rest_id) === id))
  .filter((record): record is Record<string, unknown> => !!record);
const secondPageRecords = secondPageIds
  .map((id) => records.find((record) => String(record.rest_id) === id))
  .filter((record): record is Record<string, unknown> => !!record);
const elapsedMs = performance.now() - startedAt;

const fullSerializedBytes = Buffer.byteLength(JSON.stringify(records));
const initialSerializedBytes = Buffer.byteLength(JSON.stringify(firstPageRecords));
const secondSerializedBytes = Buffer.byteLength(JSON.stringify(secondPageRecords));
const payload = {
  ok: firstPageRecords.length === Math.min(initialPageSize, records.length),
  records: records.length,
  elapsed_ms: Number(elapsedMs.toFixed(3)),
  initial_page_size: firstPageRecords.length,
  next_page_size: secondPageRecords.length,
  full_serialized_bytes: fullSerializedBytes,
  initial_serialized_bytes: initialSerializedBytes,
  next_serialized_bytes: secondSerializedBytes,
  initial_vs_full_ratio:
    fullSerializedBytes > 0 ? Number((initialSerializedBytes / fullSerializedBytes).toFixed(4)) : 0,
  gates: {
    initial_page_under_5_percent_of_5000:
      records.length >= 5000 ? initialSerializedBytes / fullSerializedBytes < 0.05 : null,
    browser_first_visible_rows_required:
      'This model benchmark verifies the paging ratio. The browser gate verifies actual first visible row timing.',
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
