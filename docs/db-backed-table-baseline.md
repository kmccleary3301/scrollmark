# DB-Backed Table Baseline And Regression Record

This document records the baseline for the DB-backed table rewrite. It is intentionally split into two parts:

- A historical pre-rewrite baseline reconstructed from the original plan, recovered diagnostics, and observed user symptoms.
- A current regression baseline backed by machine-readable harness artifacts in `e2e/perf/out`.

The original array-based implementation was removed during the migration, so a fresh pre-refactor benchmark cannot be rerun from the current worktree without checking out an older revision. Treat the historical baseline as the failure mode we are replacing, and the current regression baseline as the gate future changes must preserve or improve.

## Historical Array-Based Baseline

Observed symptoms before the DB-backed rewrite:

- Opening the Bookmarks table had large initial latency at roughly 10k+ indexed bookmarks.
- The table counter and visible rows could update multiple times before settling.
- Very deep scrolling could freeze the browser.
- The table state model grew around a large `records` array.
- Search documents were loaded as a large array on table open.
- The worker search corpus could warm from the entire corpus before explicit search intent.
- Folder filters derived from in-memory search documents.
- Export and alternate views could force full result materialization through table-owned arrays.
- Selection/result snapshots could store large result ID arrays.

Primary historical code paths listed in the original playbook:

- `src/core/database/hooks.ts`: `useCapturedRecords` appended pages into a growing array, and `useSearchDocuments` could materialize all search documents.
- `src/core/database/manager.ts`: `extGetCapturePage` used offset pagination, and `extGetSearchDocuments` materialized the full search-document set.
- `src/components/table/table-view.tsx`: opened captured records and search documents immediately.
- `src/components/table/use-result-set-controller.ts`: built broad maps, worker corpora, sorted arrays, selected arrays, and result snapshots from hydrated arrays.
- `src/components/table/base.tsx`: virtualized DOM rendering but accepted `sortedRecords` arrays and could call `loadAll()` for export.
- `src/components/table/tweet-media-masonry.tsx`: flattened media from all records passed to it.
- `src/components/modals/export-data.tsx`: exported by materializing active records into arrays.

This historical baseline is qualitative because the old implementation is no longer present in the current worktree. The regression gates below are the authoritative replacement for future comparisons.

## Current Regression Baseline

These are the current machine-readable benchmark artifacts that define the post-rewrite floor. A future change regresses if it breaks the listed gates or materially exceeds the bounded-state numbers without a documented reason.

| Area | Artifact | Baseline |
| --- | --- | --- |
| 100k table open and deep scroll | `e2e/perf/out/deep-scroll-app-100k-index-pages.json` | Passed. Table state stayed bounded at max 88 hydrated records, max 88 result IDs, 0 search documents, and no table long task above 250ms. |
| 100k export start/cancel memory | `e2e/perf/out/export-memory-app-100k.json` | Passed. Table opened at `rendered 35/100000`; JSON export cancelled after 3 streamed rows; bundle export cancelled after one 100-row worker batch; table state stayed at 80 hydrated rows, 0 search documents, 80 result IDs, 160 lookup IDs, and 342 cached source rows. |
| 100k standalone browser smoke | `e2e/perf/out/large-count-smoke-100000-current.json` | Passed in Chromium with 100000 records, 1120 loaded table rows, max long task 107ms, p95 frame 16.8ms, no page errors, and no blank/duplicate/order violations. |
| 50k standalone browser smoke | `e2e/perf/out/large-count-smoke-50000-current.json` | Passed the wrapper gate. Harness generated 25000 browser records for that run, held loaded rows to 1120, max long task 78ms, p95 frame 16.8ms, and no page errors. |
| Chromium and Firefox smoke | `e2e/perf/out/large-count-smoke-5000-chromium-firefox.json` | Passed in both browser engines with 5000 records, bounded table rows at 1120, no page errors, no blank/duplicate windows, large-folder masonry not trimmed to the loaded table page, Chromium max long task 70ms, and Firefox p95 frame 17.3ms. |
| 10k completed export integrity | `e2e/perf/out/export-modal-app-10k-refresh.json` | Passed. All-results JSON exported 10000 rows, all-minus-one exported 9999 rows, explicit selection stayed finite, bundle ZIP used 100-row worker batches, table hydration stayed at 160 rows, search documents stayed at 0, lookup IDs stayed at 320, and source cached rows stayed at 1520. |
| 12k DB-indexed media masonry | `e2e/perf/out/media-masonry-app-12k-indexed.json` | Passed. Media masonry used DB media cursor pages, loaded media incrementally, kept table hydration at 80, and kept search documents at 0. |
| Recovered real-data browser import | `e2e/perf/out/recovered-db-browser-round019.json` | Passed. Imported the 25 MB v6 round_019 export through the built userscript into Chromium IndexedDB, opened 415 recovered Bookmarks captures, rendered 19 folder facet options, selected a 248-row recovered folder source, and kept table state bounded at 80 hydrated rows, 0 search documents, 80 result IDs, and 232 lookup IDs. |
| Search threshold/degradation | `e2e/perf/out/search-threshold-app.json` | Passed. Above-threshold search warning and degraded readiness state render without hydrating search documents into table state. |
| Search cancellation | `e2e/perf/out/search-cancellation-app.json` | Passed. Baseline search reaches ready state, rapid query changes cancel stale worker requests, and stale results do not overwrite the current query. |

## Current Budgets

Keep these budgets aligned with `docs/db-backed-table-progress-ledger.md`:

- 10k records: first visible rows under 1.5s on development hardware.
- 100k records: first visible rows under 2.5s on development hardware.
- Normal table open: no full search-document load.
- Empty-query table open: no full search worker corpus.
- Deep scroll: no table-code main-thread stall above 250ms.
- Normal browsing memory: visible rows plus bounded page cache, not the full result set.
- Export all: streams from a result descriptor and does not call table `loadAll()`.

## Regression Review Rules

When changing table, source, folder, search, export, or media code:

- Re-run the smallest harness that covers the touched behavior.
- Re-run `npm run build`, `npm run lint`, `npx tsc --noEmit`, and `git diff --check` before marking a slice complete.
- If a bounded-state number increases, explain whether the increase is intentional and still bounded.
- If a high-count seed is too expensive for routine use, document the practical substitute and the uncovered risk.
- Do not compare future work against the removed array-based path unless an old revision is intentionally checked out and benchmarked.
