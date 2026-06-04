# Final Release Checklist

## Required Gates

- [x] Build e2e userscript: `npm run build:e2e`
- [x] Build production userscript: `npm run build`
- [x] Canonical bundle export path exists.
- [x] Canonical bundle import path exists.
- [x] Legacy JSON/JSONL import path exists.
- [x] Imported bundles are isolated from live captures.
- [x] Imported bundle delete does not delete live captures.
- [x] Imported text rendering is escaped.
- [x] Media/export URLs are filtered to `http`/`https`.
- [x] ZIP path traversal and decompression limits exist.
- [x] Basic Bundle Library UI exists.
- [x] Imported subset re-export exists.
- [x] QC fixtures exist.
- [x] Lint/prettier gate passes.
- [x] Search worker path exists with large-corpus main-thread fallback blocked.
- [x] Canonical bundle ZIP export worker path exists with progress and cancellation.
- [x] Initial viewer hydration is paged instead of full-corpus on open.
- [x] Search documents are materialized for live captures and imported bundles.
- [x] Performance diagnostics section exists.
- [x] Final Hill perf suite exists and passes locally.
- [x] Search phrase-quality harness exists and passes locally.
- [x] Chrome CDP metric smoke probe exists and passes locally.
- [x] Local install endpoint verified for Firefox/e2e and Chrome/e2e build artifacts.
- [x] Scrollmark user-facing rebrand is applied with install/header/launcher icon policy documented.
- [x] DB-backed table rewrite automated gates are mapped below.
- [ ] Manual browser QC completed against real exports.
- [ ] Script store README/screenshots updated.
- [ ] Final README screenshots refreshed after manual QC if current screenshots no longer represent the release UI.

## DB-Backed Table Rewrite Gates

Run these before publishing a release that includes the DB-backed table rewrite.

### Automated Preflight

- [x] Build release/store/e2e artifacts: `npm run build:all`
- [x] Validate userscript metadata and store-safe artifact shape: `npm run check:metadata`
- [x] Lint: `npm run lint`
- [x] TypeScript: `npx tsc --noEmit`
- [x] Whitespace/diff hygiene: `git diff --check`

### Source And DB Contracts

- [x] Live DB/source APIs: `npm run test:db-source-live`
- [x] Result-source descriptors/adapters: `npm run test:result-source-contract`
- [x] Result-set lookup and bounded snapshots: `npm run test:result-set-lookup`
- [x] DB migration compatibility: `npm run test:db-migration-compat`
- [x] Recovered v6 fake-IndexedDB import: `npm run test:recovered-db-import`
- [x] Normal queued/chunked write indexing: `npm run test:write-indexing-regression`

### App Workflows

- [x] App diagnostics and no eager search-document load: `npm run test:app-diagnostics-smoke`
- [x] Small archive workflow, folder filter, search, export, mutation, clear/reset: `npm run test:small-dataset-workflow`
- [x] Export modal source streaming, all-minus-exceptions, bundle batching, cancellation: `npm run test:export-modal-app`
- [x] 100k export start/cancel memory: `npm run test:export-memory-app`
- [x] Variable-height table and fullscreen scroll: `npm run test:variable-height-table`
- [x] Folder facet UI and source-backed folder windows: `npm run test:folder-source-stress`
- [x] Deep scroll and source-window scheduling: `npm run test:deep-scroll-app`
- [x] Media masonry source-backed behavior: `npm run test:media-masonry-app`
- [x] Recovered real-data browser import and folder browsing: `npm run test:recovered-db-browser`

### Search Gates

- [x] Search phrase semantics: `npm run test:search-phrase-quality`
- [x] Search performance measurement through 100k synthetic rows: `npm run test:search-performance`
- [x] Search threshold guard: `npm run test:search-threshold-guard`
- [x] Above-threshold blocked/degraded app state: `npm run test:search-threshold-app`
- [x] Rapid query cancellation and stale-result suppression: `npm run test:search-cancellation-app`

### Browser/Scale Smoke

- [x] 100k table open/deep-scroll current baseline: `e2e/perf/out/deep-scroll-app-100k-index-pages.json`
- [x] 10k completed export current baseline: `e2e/perf/out/export-modal-app-10k-refresh.json`
- [x] 12k DB-indexed media current baseline: `e2e/perf/out/media-masonry-app-12k-indexed.json`
- [x] Chromium and Firefox smoke current baseline: `e2e/perf/out/large-count-smoke-5000-chromium-firefox.json`
- [x] Baseline/regression record: `docs/db-backed-table-baseline.md`

### Manual QC For This Rewrite

- [x] Recovered round_019 export opens and browses in Chromium through `npm run test:recovered-db-browser`.
- [ ] Install the release or store artifact in a real userscript manager and confirm the widget appears on `x.com`.
- [ ] Open Bookmarks on a real account/archive and verify first rows render before folder/search/media/export actions.
- [ ] Search a small/normal corpus and confirm readiness/cancellation behavior is visible.
- [ ] Select a bookmark folder and confirm rows narrow without freezing.
- [ ] Open Export Data and confirm result-set count and all/selected scope behavior.
- [ ] Open Media view and confirm cards render incrementally.
- [ ] Use Clear/reset only on a disposable archive and confirm counts/table reset.

### DB-Backed Table Stop Conditions

- Do not publish if opening Bookmarks loads all search documents before search intent.
- Do not publish if table hydration, result IDs, or lookup IDs scale linearly with total result count during normal browsing.
- Do not publish if all-results export calls table `loadAll()` or requires table-owned full arrays.
- Do not publish if recovered v6 import opens but Bookmarks cannot render from a source descriptor.
- Do not publish if a non-source-backed alternate view can silently flatten a massive result set.
- Do not publish if release/store metadata reintroduces external `@require` URLs or local e2e update URLs.

## Manual QC Fixtures

- `e2e/fixtures/bundles/legacy-export-sample.json`
- `e2e/fixtures/bundles/malicious-legacy-export-sample.json`

## Stop Conditions

- Do not publish stable if imported HTML/script executes.
- Do not publish stable if importing/deleting a bundle changes live capture counters.
- Do not publish stable if canonical ZIP export cannot be re-imported.
- Do not publish stable if lint remains intentionally required by CI.
