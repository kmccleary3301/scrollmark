# Final Hill Performance Gates

This document defines the automated and manual gates required before the final manual QC session.

## Search Gates

- Search input must remain responsive while typing long queries.
- Search execution must run through the worker path for non-trivial corpora.
- Stale search responses must be ignored.
- Diagnostics must report search worker availability, query timings, stale/cancel counts, corpus size, and result count.

Targets:

- 5k records: no main-thread long task above 100 ms during rapid typing.
- 5k records: final warm result under 150 ms after final keypress where practical.
- 25k records: no freeze; staged result is acceptable; warm target under 400 ms.

## Viewer Gates

- Opening a large viewer must render first visible rows without requiring all records to hydrate.
- Table scrolling must not show blank virtual windows or duplicate visible row IDs while moving downward.
- Variable-height table rows must be measured and windowed without relying on a single fixed row height.
- Folder-filtered masonry must use the full indexed corpus, not only the currently hydrated page.
- Diagnostics must report first visible rows time and hydrated row count.
- Full-corpus fallback must be explicit and measured.

Targets:

- 5k records: first visible rows under 500 ms.
- 25k records: first visible rows under 1.5 s.
- Browser scroll harness: no blank-window violations.
- Browser scroll harness: no duplicate visible IDs.
- Browser scroll harness: p95 frame delta under 80 ms.
- Browser scroll harness: max long task under 250 ms.
- Browser scroll harness: large-folder masonry renders more than the initial loaded-page-sized subset.

## Bundle ZIP Export Gates

- Canonical bundle ZIP export must use the worker path when available.
- Progress must appear quickly.
- Cancellation must work before finalization.
- Output ZIP must import and validate.
- Diagnostics must report export phase timing and worker availability.

Targets:

- Progress under 250 ms for large jobs.
- No main-thread long task above 100 ms during export work.
- Default compression level is 1. Level 0 is available for fastest export.

## Benchmark Commands

```bash
cd /home/skra/projects/twitter_scraping/greasemonkey_project/twitter-web-exporter
npm run lint
npm run build
./e2e/perf/run_final_hill_perf_suite.sh
```

The current perf suite covers:

- synthetic search engine latency,
- focused phrase-quality checks for exact phrase ranking, quoted enforcement, slop, and `@handle` author constraints,
- viewer paging ratio,
- browser-driven table and masonry scroll behavior in Chromium and Firefox,
- canonical bundle ZIP latency and validity,
- canonical bundle export/import round trip,
- Chrome CDP metric collection smoke test.

Latest local evidence, 2026-05-18:

- Full command passed: `npm run lint && npm run build && npm run build:e2e && TWE_BUILD_VARIANT=chrome-e2e npx vite build && ./e2e/perf/run_final_hill_perf_suite.sh`.
- Output directory: `e2e/perf/out/20260518_135713`.
- 5k search engine p95: `30.859 ms`.
- 25k search engine p95: `137.783 ms`.
- Phrase-quality harness: all checks passed.
- Viewer paging model: initial page ratio `0.0318` for 5k and `0.0064` for 25k.
- Bundle ZIP benchmark: 5k records exported in `458.981 ms`, output validated.
- Bundle roundtrip: 250 sampled records imported successfully, zero failures.
- Chrome CDP smoke: userscript injection succeeded and widget root existed.

The Chrome CDP smoke test proves browser metric collection is available on this machine. Final release signoff still requires the unified manual QC session against real Firefox and Chrome userscript installs.

Latest browser-scroll evidence, 2026-05-19:

- Full perf suite with browser-scroll harness passed: `OUT_DIR=e2e/perf/out/20260519_110321_final_suite_with_browser ./e2e/perf/run_final_hill_perf_suite.sh`.
- Synthetic 5k browser-scroll output: `e2e/perf/out/20260519_110321_final_suite_with_browser/browser-viewer-scroll-5000.json`.
- Chromium synthetic 5k browser-scroll: zero blank-window violations, zero duplicate visible IDs, max long task `139 ms`, p95 frame delta `16.8 ms`.
- Firefox synthetic 5k browser-scroll: zero blank-window violations, zero duplicate visible IDs, p95 frame delta `33.42 ms`.
- Real bookmark export browser-scroll also passed separately against `/home/skra/projects/twitter_scraping/misc/round_018/twitter-Bookmarks-results-1776536322969.json`.
- Real bookmark export output: `e2e/perf/out/20260519_110103_real_bookmarks_browser/browser-viewer-scroll-real-bookmarks.json`.
