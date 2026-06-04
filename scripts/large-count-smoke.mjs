#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split('=');
      return [key, rest.join('=') || '1'];
    }),
);

const count = Math.max(1, Math.floor(Number(args.get('count') || 10_000)));
const browsers = args.get('browsers') || 'chromium';
const outPath = path.resolve(
  args.get('out') || `e2e/perf/out/large-count-smoke-${count}-${Date.now()}.json`,
);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollmark-large-count-smoke-'));
const recordsPath = path.join(tempDir, `synthetic-${count}.json`);
const harnessOutPath = path.join(tempDir, 'browser-viewer-scroll.json');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run('node', ['e2e/perf/generate_corpus.mjs', recordsPath, String(count)]);
run('node', [
  'e2e/perf/browser_viewer_scroll_harness.mjs',
  recordsPath,
  harnessOutPath,
  `--browsers=${browsers}`,
]);

const harness = JSON.parse(fs.readFileSync(harnessOutPath, 'utf8'));
const boundedLoadLimit = Math.min(count, Number(args.get('loaded-limit') || 1500));
const results = Array.isArray(harness.results) ? harness.results : [];
const gates = {
  harness_ok: harness.ok === true,
  table_loaded_rows_bounded: results.every((result) => {
    const loaded = Number(result?.table?.loaded || 0);
    return loaded > 0 && loaded <= boundedLoadLimit;
  }),
  no_page_errors: results.every((result) => result?.gates?.no_page_errors === true),
  max_long_task_under_250_ms: results.every(
    (result) => result?.gates?.max_long_task_under_250_ms === true,
  ),
};

const payload = {
  ok: Object.values(gates).every(Boolean),
  count,
  browsers,
  generated_at: new Date().toISOString(),
  bounded_load_limit: boundedLoadLimit,
  gates,
  harness,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.ok ? 0 : 1);
