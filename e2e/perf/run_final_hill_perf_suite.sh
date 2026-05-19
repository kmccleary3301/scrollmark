#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
OUT_DIR="${OUT_DIR:-e2e/perf/out/$(date +%Y%m%d_%H%M%S)}"
mkdir -p "$OUT_DIR"
node e2e/perf/generate_corpus.mjs "$OUT_DIR/synthetic-tweets-5000.json" 5000
node e2e/perf/generate_corpus.mjs "$OUT_DIR/synthetic-tweets-25000.json" 25000
npx tsx e2e/perf/search_engine_latency_benchmark.ts "$OUT_DIR/synthetic-tweets-5000.json" "$OUT_DIR/search-engine-5000.json"
npx tsx e2e/perf/search_engine_latency_benchmark.ts "$OUT_DIR/synthetic-tweets-25000.json" "$OUT_DIR/search-engine-25000.json"
npx tsx e2e/perf/search_phrase_quality_harness.ts "$OUT_DIR/search-phrase-quality.json"
npx tsx e2e/perf/result_set_lookup_harness.ts "$OUT_DIR/result-set-lookup.json"
npx tsx e2e/perf/viewer_paging_model_benchmark.ts "$OUT_DIR/synthetic-tweets-5000.json" "$OUT_DIR/viewer-paging-5000.json"
npx tsx e2e/perf/viewer_paging_model_benchmark.ts "$OUT_DIR/synthetic-tweets-25000.json" "$OUT_DIR/viewer-paging-25000.json"
node e2e/perf/browser_viewer_scroll_harness.mjs "$OUT_DIR/synthetic-tweets-5000.json" "$OUT_DIR/browser-viewer-scroll-5000.json" --browsers=chromium,firefox
npx tsx e2e/perf/bundle_export_latency_benchmark.ts "$OUT_DIR/synthetic-tweets-5000.json" "$OUT_DIR/bundle-export-5000.json"
npx tsx e2e/bundles/canonical_bundle_roundtrip_harness.ts "$OUT_DIR/synthetic-tweets-5000.json" "$OUT_DIR/bundle-roundtrip-250.json"
node e2e/perf/chrome_cdp_smoke_probe.mjs "$OUT_DIR/chrome-cdp-smoke.json"
printf 'Final Hill perf suite wrote %s\n' "$OUT_DIR"
