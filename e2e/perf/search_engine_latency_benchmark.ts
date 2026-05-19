import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  prepareAdvancedTableSearchCorpus,
  runAdvancedTableSearchPrepared,
} from '@/utils/advanced-table-search';

type BenchmarkResult = {
  query: string;
  elapsed_ms: number;
  total_matches: number;
  top_ids: string[];
};

const [recordsPath, outPath] = process.argv.slice(2);
if (!recordsPath || !outPath) {
  console.error('usage: tsx e2e/perf/search_engine_latency_benchmark.ts <records.json> <out.json>');
  process.exit(2);
}

const records = JSON.parse(fs.readFileSync(path.resolve(recordsPath), 'utf8')) as Array<
  Record<string, unknown>
>;
const queries = [
  'full writeup on how',
  '"full writeup on how"',
  '@researcher_7 "exact phrase checkpoint"',
  'masonry layout performance media',
  'ParadeDB phrase boosting exact snippet ranking',
  'folder:"Research Revisit 02" autonomous research agents',
];

const prepareStart = performance.now();
const prepared = prepareAdvancedTableSearchCorpus(records);
const prepareMs = performance.now() - prepareStart;

const results: BenchmarkResult[] = queries.map((query) => {
  const start = performance.now();
  const result = runAdvancedTableSearchPrepared(prepared, query);
  const elapsed = performance.now() - start;
  return {
    query,
    elapsed_ms: Number(elapsed.toFixed(3)),
    total_matches: result.totalMatches,
    top_ids: result.records
      .slice(0, 10)
      .map((row) => String((row as Record<string, unknown>).rest_id || '')),
  };
});

const payload = {
  ok: true,
  records: records.length,
  prepare_ms: Number(prepareMs.toFixed(3)),
  results,
  gates: {
    p1_target_no_main_thread_search: 'Browser worker benchmark required for final gate.',
    engine_p95_ms: Math.max(...results.map((row) => row.elapsed_ms)),
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
