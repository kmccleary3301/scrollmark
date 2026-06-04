# DB-Backed Table Scalability Playbook

This document is the working plan for replacing Scrollmark's current array-based table data model with a DB-backed, paged, bounded-memory architecture. The goal is not just to make 10k bookmarks survivable. The goal is to remove architectural cliffs so that opening, browsing, filtering, searching, selecting, and exporting remain predictable as the local archive grows far beyond normal human use.

The plan is intentionally detailed and weighted. Use the weights to track real completion, not effort spent. A task counts only when its acceptance criteria pass.

## Status Model

Use these status markers in follow-up edits:

- `[ ]` Not started.
- `[~]` In progress.
- `[x]` Complete and verified.
- `[!]` Blocked or needs a decision.

Progress formula:

```text
completion_percent = sum(weight of completed checklist items) / 100
```

Do not mark an item complete because the implementation exists. Mark it complete only after the listed verification passes.

## Historical Baseline

The original array-based baseline is now historical. The old table path has been removed, so this section describes the failure mode that motivated the rewrite rather than the current implementation. The current regression baseline lives in `docs/db-backed-table-baseline.md`.

The original table was only partially virtualized:

- The DOM renders a small visible row window.
- The app state still grows one large `records` array as the user scrolls.
- Search documents are loaded as one large array on table open.
- The search worker is warmed with the entire corpus shortly after opening.
- Folder filters derive from in-memory search documents.
- Export can call `loadAll()` and materialize every row into UI state.
- Result snapshots and selection state can contain full result ID arrays.
- Scrolling far triggers repeated page loads, then full-array remaps, sorts, selection recomputation, result snapshot creation, virtual offset recalculation, and sometimes search corpus updates.

Important current files:

- `src/core/database/hooks.ts`
  - `useCapturedRecords` appends pages to one growing `records` array.
  - `useSearchDocuments` loads all search documents on table open.
- `src/core/database/manager.ts`
  - `extGetCapturePage` uses offset pagination.
  - `extGetSearchDocuments` materializes the full search document set.
- `src/components/table/table-view.tsx`
  - Opens both captured records and all search documents immediately.
- `src/components/table/use-result-set-controller.ts`
  - Builds full maps, full worker corpora, full sorted arrays, full selected arrays, and full result snapshots.
- `src/components/table/base.tsx`
  - Virtualizes rendering but receives full `sortedRecords`.
  - Builds `virtualOffsets` for every loaded row.
  - Calls `loadAll()` for export.
- `src/components/table/tweet-media-masonry.tsx`
  - Builds all media items from all records passed to it.
- `src/components/modals/export-data.tsx`
  - Exports by materializing active records into arrays.

Current source-backed architecture details are documented in `docs/db-backed-table-developer-guide.md`.

## Objective

Replace the current table model with a DB-backed result source that:

- Opens the table with bounded memory and low latency.
- Keeps table browsing memory approximately constant.
- Supports large bookmark sets without freezing on deep scroll.
- Preserves current table functionality where feasible.
- Preserves advanced search semantics, either with a lazy in-memory worker path or a later persisted search index.
- Streams export work from DB-backed result descriptions instead of forcing all records into table state.
- Gives the UI accurate counts, stable loading states, and explicit degradation when a feature needs expensive work.

## Brutal Feasibility Boundaries

### Feasible Without A New Search Engine

- Fast first table open.
- Bounded-memory scroll browsing.
- Keyset/cursor pagination over captures.
- DB-backed folder facets and folder filters.
- DB-backed counts.
- Hydrating only visible rows.
- Exporting all rows by streaming/cursoring from IndexedDB.
- Avoiding full search corpus warmup until the user searches.
- Maintaining variable-height virtual rows with estimates plus measured corrections.

### Feasible But Requires Schema And Query Work

- Efficient folder-filtered pagination by recency.
- Efficient sort by common projected fields.
- Deep scrolling without offset-scan cost.
- Media view that pages media candidates instead of flattening all currently loaded tweets.
- Result snapshots represented by query descriptors instead of full ID arrays.

### Not Feasible With IndexedDB Alone

IndexedDB does not provide full-text search. The current advanced search semantics include phrases, slop, boolean logic, filters, ranking, highlights, and deduplication. Keeping those exact semantics while avoiding a full in-memory corpus requires a persisted inverted index.

Acceptable paths:

- Short and medium term: lazy-load the existing worker corpus only when the user enters a query.
- Long term: build a persisted search index in IndexedDB.

Do not pretend a simple IndexedDB `.where()` query can replace the current advanced search engine.

## Non-Negotiable Guardrails

- Do not load all records on table open.
- Do not load all search documents on table open.
- Do not warm full search corpora before the user expresses search intent.
- Do not call `loadAll()` from UI table state for export.
- Do not let deep scroll append indefinitely to a single in-memory `records` array.
- Do not store full current result IDs in UI state for unbounded result sets.
- Do not remove existing user-facing features silently. If a feature needs a temporary fallback, show a clear state and track it in this document.
- Do not merge large architectural changes without synthetic large-count tests.
- Keep the `1.0.2` injection/bundling hotfix separate from this table architecture work unless explicitly combining release work.

## Target Architecture

### Core Shape

The table should consume a `ResultSource`, not a raw array.

Conceptual interface:

```ts
type ResultSourceKey = string;

type ResultWindowRequest = {
  startIndex: number;
  limit: number;
  anchor?: ResultCursor;
  direction?: 'forward' | 'backward';
};

type ResultWindow<T> = {
  sourceKey: ResultSourceKey;
  totalCount: number;
  startIndex: number;
  rows: T[];
  rowIds: string[];
  hasBefore: boolean;
  hasAfter: boolean;
  cursorBefore?: ResultCursor;
  cursorAfter?: ResultCursor;
};

type ResultSource<T> = {
  key: ResultSourceKey;
  mode: 'captures' | 'folder' | 'search' | 'selection' | 'bundle';
  totalCount(): Promise<number>;
  getWindow(request: ResultWindowRequest): Promise<ResultWindow<T>>;
  getByIds(ids: string[]): Promise<T[]>;
  streamRows(args: StreamRowsArgs<T>): AsyncIterable<T>;
  describe(): ResultSourceDescriptor;
};
```

The exact TypeScript does not need to match this sketch, but the responsibilities should.

### Data Ownership

- Database layer owns persistent row order, counts, cursors, search documents, and projections.
- Result source layer owns query descriptors and page fetching.
- Table controller owns UI state, active source descriptor, visible window request, selection descriptor, and sorting/filter controls.
- Virtualizer owns scroll offset estimation and visible index range.
- Export owns streaming from a descriptor, not table-owned arrays.

### Memory Target

For normal browsing:

- Visible rows: roughly 20 to 120 hydrated records.
- Page cache: configurable, initially 5 to 15 pages.
- Search documents: zero loaded on open.
- Search worker corpus: zero loaded until search query.
- Result ID arrays: bounded unless the user explicitly creates a finite selected set.

## Weighted Completion Plan

### 1. Baseline, Instrumentation, And Fixtures - 8 Points

- [x] **1.1 Add table lifecycle metrics - 1.0**
  - Track table open start, first rows rendered, first stable layout, first user-interactive point.
  - Include extension name, entity type, total count, loaded row count, search doc count if known, and active mode.
  - Acceptance: diagnostics bundle exposes these metrics after opening Bookmarks.

- [x] **1.2 Add memory-sensitive counters - 1.0**
  - Track hydrated records in UI state, cached pages, loaded search documents, worker corpus size, selected explicit IDs, and result snapshot ID count.
  - Acceptance: diagnostics show bounded values during normal browsing.

- [x] **1.3 Add synthetic DB seeding utility - 1.5**
  - Seed captures, tweets, users, and search documents at 1k, 10k, 50k, 100k, and 250k counts.
  - Include folder distributions: no folder, one huge folder, many small folders, mixed missing folder names.
  - Include tweet text distributions for search tests.
  - Current state: synthetic fixtures are gated to diagnostics/dev contexts, generate tweet rows chunk-by-chunk, and use a synthetic-only raw bulk write path so normal capture merge/upsert behavior is unchanged.
  - Current state: `SYNTHETIC_SEED_PRESETS` exposes 1k, 10k, 50k, 100k, 250k, one-huge-folder, many-small-folder, no-folder, and 100k capture-scroll profiles; `getSyntheticSeedPlan()` gives a cheap count/write plan for high-count presets without paying the browser seed cost.
  - Current state: `source-window` raw-record mode can seed full capture/search-document source indexes while storing only enough raw tweets to hydrate source windows. This is valid for table/folder/media/search source-window stress, while complete mode remains available for export integrity and full raw-record workflows.
  - Verification: `npm run test:synthetic-seed-matrix -- e2e/perf/out/synthetic-seed-matrix.json` passed, covering all required count presets through 250k, no-folder/one-huge/many-small/mixed missing-name distributions, default/variable-height/sparse-media/dense-media content profiles, `includeSearchDocuments: false`, bounded `source-window` raw storage with full capture/search indexes, and clear-all.
  - Verification: high-count browser evidence remains in the dedicated behavior harnesses: 100k complete-mode capture-scroll without search documents, 100k one-huge and many-small source-window folder stress, 100k dense/sparse media source-window stress, real 60k chunked search corpus prep, and 250k generated browser smoke.
  - Acceptance: local e2e/dev workflow can create and clear synthetic datasets without using X.

- [x] **1.4 Add large-count smoke script - 1.0**
  - Open table and measure first render latency, memory counters, and scroll responsiveness.
  - Acceptance: script fails if table opens by materializing all records or all search docs.

- [x] **1.5 Add performance budget document section - 1.0**
  - Define target budgets:
    - 10k records: first visible rows under 1.5s on development hardware.
    - 100k records: first visible rows under 2.5s.
    - Normal table open: no full search-doc load.
    - Deep scroll: no long main-thread freeze above 250ms from table code.
  - Acceptance: budgets live in this doc or a linked benchmark doc and are used by tests.

- [x] **1.6 Capture current baseline before refactor - 1.5**
  - Measure current behavior on 10k and 50k synthetic records.
  - Record first open time, number of table updates before stable render, scroll freeze symptoms, memory counters, and search worker corpus behavior.
  - Current state: the original array-based implementation is no longer present in the current worktree, so a fresh pre-refactor run is not possible without checking out an older revision. `docs/db-backed-table-baseline.md` now records the historical failure-mode baseline and the current machine-readable regression baseline from existing harness artifacts.
  - Verification: the baseline record includes 50k/100k standalone smoke, 100k deep-scroll, 100k export-memory, 10k export-integrity, 12k media, recovered real-data browser import, search threshold/degradation, search cancellation, and Chromium/Firefox smoke artifacts.
  - Acceptance: baseline numbers are committed or attached in docs so regressions are visible.

- [x] **1.7 Add a progress and risk ledger - 1.0**
  - Track completed weight, current gate, active branch decisions, unresolved risks, and benchmark deltas in one place.
  - Update it at the end of each implementation slice.
  - Acceptance: anyone can open the ledger and see whether the migration is ahead, behind, blocked by a decision, or failing a performance budget.

### 2. Database Query Foundation - 12 Points

- [x] **2.1 Define DB result descriptors - 1.0**
  - Add typed descriptors for captures, folder filters, search results, explicit selections, and exported result sets.
  - Descriptor must be serializable.
  - Acceptance: descriptors can be logged and stored without containing hydrated records.

- [x] **2.2 Add keyset capture pagination - 2.0**
  - Add cursor APIs using `(created_at, id)` or equivalent stable ordering.
  - Support newest-first and oldest-first.
  - Avoid `offset()` for deep sequential browsing.
  - Current state: capture sources use source-local sparse checkpoints so progressive start-index windows are served from cursor pages instead of repeated `offset()` reads.
  - Current state: persisted capture index pages now cover cold random-access capture windows when the count/revision-matched page map exists, and missing maps schedule a delayed background build instead of blocking the first table window.
  - Verification: `npm run test:db-source-live` covers capture cursor continuation, explicit capture index-page builds, stale index invalidation after capture writes, and delayed background index builds. App-integrated 100k deep-scroll coverage verifies middle/bottom capture windows through the index-page path.
  - Acceptance: fetching page 1 and page 1000 has similar query complexity when using cursors.

- [x] **2.3 Add capture count and lightweight ID page APIs - 1.0**
  - Return IDs/cursors without hydrating tweets/users.
  - Acceptance: table can know count and row IDs independently from hydrated row payloads.

- [x] **2.4 Add search document count APIs - 1.0**
  - Count by extension/entity type.
  - Count by folder.
  - Count by source where needed.
  - Current state: folder-scoped counts use the `[extension_name+entity_type+folder_id+observed_at_ms+id]` compound index instead of scanning all extension/type documents and filtering folder IDs in JS.
  - Current state: when folder facets already provide selected folder counts, `TableView` passes that known total to the folder result source so the first selected-folder window does not issue a redundant high-count count query.
  - Acceptance: folder/status UI can get counts without full `toArray()`.

- [x] **2.5 Add folder facet APIs - 1.5**
  - Return folder IDs, folder labels, counts, and status counts.
  - Use cursor iteration or indexed access.
  - Avoid returning every document.
  - Current state: `extGetSearchDocumentFolderFacets` returns `totalDocuments`, facet IDs/labels/counts/status, and aggregate `api-name`/`id-only`/`none` counts without returning search-document rows to the UI. `useSearchDocumentFolderFacets` loads that summary independently from the full lazy search-document corpus, and `useBookmarkFolderUiState` uses the summary for dropdown options and status counts whenever it is available.
  - Verification: `npm run test:db-source-live` verifies facet labels, id-only fallback status, unfiled counts, and backfilled API-name promotion. `npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-facet-ui.json` verifies the built userscript emits DB facet events for a 5k one-huge-folder dataset and a 5k/2k-folder many-folder dataset, renders the dropdown/status UI from those facets, and keeps table search-document hydration at 0.
  - Acceptance: bookmark folder dropdown and status widget render from facets only.

- [x] **2.6 Add folder-filtered page APIs - 1.5**
  - Page documents by folder and recency.
  - Hydrate only requested page IDs.
  - If existing indexes are insufficient, add a DB version with compound indexes such as `[extension_name+entity_type+folder_id+observed_at_ms]`.
  - Current state: one-or-more no-query bookmark folders use DB-backed folder pages; multi-folder windows are merged from per-folder pages.
  - Current state: folder sources use source-local sparse checkpoints for progressive start-index windows.
  - Current state: folder sources now have descriptor-scoped persisted index pages keyed by source descriptor, source count, folder scope, and source revision. Cold start-index windows try those fixed-size row-ID pages before checkpoint walking or offset fallback.
  - Current state: missing folder source page maps schedule a delayed background build from cursor pages, and search-document mutations/backfills/imports/clears invalidate stale page maps.
  - Verification: `npm run test:db-source-live` covers background folder index warmup and a >5k cold deep folder window served from persisted folder source index pages with zero offset fallback calls. `SCROLLMARK_FOLDER_STRESS_SCENARIOS=huge SCROLLMARK_FOLDER_STRESS_HUGE=6000 SCROLLMARK_FOLDER_STRESS_DEEP_INDEX=1 npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-6k-index-pages.json` verifies the built userscript emits `folder-source-index-build`, uses `folder-source-index-page` for the deep folder window, and keeps the deep folder window under budget.
  - Acceptance: selecting a folder with 50k records does not load all folder docs.

- [x] **2.7 Add projected sort-key strategy - 1.0**
  - List sortable fields that can be DB-backed immediately.
  - List sortable fields that require projected columns.
  - List sortable fields that must remain client-side for visible/cached rows only until later.
  - Acceptance: no ambiguous sort behavior remains undocumented.

- [x] **2.8 Add DB query cancellation/staleness pattern - 1.0**
  - Every async page request must be ignored if a newer source key is active.
  - Current state: capture and folder source-window hooks now use latest-wins scheduling for scroll-driven window requests. While one DB window is in flight, newer non-initial window requests are coalesced to the newest requested range; stale completions emit `source-window-stale-ignored` instead of updating table state. Worker search requests have separate query cancellation coverage in 7.5.
  - Current state: mutation/source swaps are covered by app diagnostics and small-dataset workflow harnesses; rapid search changes are covered under 7.5; source-backed sorting is disabled for unbounded source browsing, so sort changes cannot launch stale DB sort queries.
  - Verification: `npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-100k-index-pages.json` proves capture-window coalescing/stale suppression through 100k rows. `SCROLLMARK_FOLDER_STRESS_SCENARIOS=huge SCROLLMARK_FOLDER_STRESS_HUGE=5000 SCROLLMARK_FOLDER_STRESS_RAPID_SCROLL=1 npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-5k-rapid-stale.json` proves folder-window coalescing and stale suppression in the built userscript. `npm run test:search-cancellation-app` proves rapid search cancellation.
  - Acceptance: rapid folder/search/sort changes do not flash stale rows.

- [x] **2.9 Add migration/backfill safety gates - 1.0**
  - New indexes or search index tables must not block normal page load for minutes.
  - Use incremental backfill where possible.
  - Current state: v8 capture index pages are optional. Existing DBs can render through cursor/checkpoint/offset fallback, while a missing count-matched capture page map schedules a delayed background build after table code has a chance to render the current window.
  - Current state: capture page maps carry a per-extension/type revision. Capture writes, imports, clears, and synthetic raw capture writes bump revisions and delete old page maps, so same-count stale maps are rejected.
  - Current state: v9 folder source index pages are optional and descriptor-scoped. Existing DBs can render through cursor/checkpoint/offset fallback while missing maps warm in the background; search-document writes, bookmark folder-name backfills, imports, clears, and synthetic search-document writes invalidate old maps.
  - Current state: the import path accepts older Dexie exports into the current schema with `acceptVersionDiff` and `acceptMissingTables`, then invalidates capture and folder source index pages so upgraded/recovered data builds fresh optional page maps.
  - Verification: `npm run test:db-source-live` verifies explicit builds, invalidation after capture writes, and delayed background builds. `npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-10k-index-lifecycle.json` verifies the built userscript still uses index pages after synthetic seed invalidation/rebuild.
  - Verification: `npm run test:recovered-db-import -- e2e/perf/out/recovered-db-import-round019-small.json` imports a recovered 25 MB v6 export into the current fake IndexedDB schema, verifies row counts, exercises the recovered capture source, builds capture index pages, and proves a recovered folder source can serve a persisted index page. `npm run test:recovered-db-browser -- e2e/perf/out/recovered-db-browser-round019.json` imports the same recovered v6 export through the built userscript in Chromium IndexedDB, opens the real Bookmarks table, selects a recovered bookmark folder from DB-backed facets, and verifies bounded capture/folder source diagnostics.
  - Verification: `SCROLLMARK_RECOVERED_DB_EXPORT=/home/skra/projects/twitter_scraping/misc/round_019/twitter-web-exporter-1779925074990.json npm run test:recovered-db-import -- e2e/perf/out/recovered-db-import-round019-large-bounded.json` imports the 168 MB recovered v6 export in fake IndexedDB, reaches `82738/82738` import progress rows in about 25.7s, skips unbounded large-export table/facet counts in favor of bounded probes, opens an 11045-row recovered Bookmarks capture source with 8 hydrated rows, builds and probes capture index pages, and proves a bounded recovered folder persisted index page hydrates 8 rows.
  - Remaining: apply equivalent migration safety to any future persisted indexes introduced after this plan.
  - Acceptance: old DBs open and show useful UI before optional backfills finish.

- [x] **2.10 Document DB invariants - 1.0**
  - Capture ID uniqueness.
  - Cursor stability.
  - Search document relationship to captures/tweets/users.
  - Folder metadata trust rules.
  - Acceptance: invariants are included in code comments or docs near APIs.

### 3. Result Source Layer - 10 Points

- [x] **3.1 Create `ResultSource` abstraction - 1.5**
  - Encapsulate count, window fetching, hydration, streaming, and descriptor serialization.
  - Current state: `src/core/database/result-source.ts` defines serializable result descriptors plus the `ResultSource` contract for count, window fetch, ID hydration, async streaming, and descriptor serialization. `src/core/database/hooks.ts` exposes descriptors and `streamRows()` to the table, while `BaseTableView`/`ExportDataModal` consume descriptors and streams without knowing capture/search-document table details.
  - Verification: `npm run test:db-source-live -- e2e/perf/out/db-source-live-result-source-closure.json` passed with capture, folder, media, streaming, cache, and diagnostics checks. `npm run test:result-source-contract -- e2e/perf/out/result-source-contract-controller-audit.json` passed for explicit/search descriptor source contracts.
  - Acceptance: table code can consume a source without knowing capture/search-doc storage details.

- [x] **3.2 Implement captures result source - 1.5**
  - Default Bookmarks/Tweets/Users browsing.
  - Uses keyset pagination and page cache.
  - Current state: `useDbBackedCapturedRecords` creates the capture result source for default Bookmarks/Tweets/Users browsing; `TableView` passes its source descriptor, source window requests, row stream, and hydrated window into `BaseTableView`. Capture windows use count snapshots, cursor/keyset pages, sparse checkpoints, persisted capture index pages for cold random access, and bounded source diagnostics/cache.
  - Verification: `npm run test:db-source-live -- e2e/perf/out/db-source-live-result-source-closure.json` passed with capture cursor continuation, indexed random windows, bounded window hydration, zero sparse-checkpoint offset fallback for the tested live source, bounded cache diagnostics, cache hits, index invalidation after writes, and delayed background index builds. App-level 100k deep-scroll/export-memory artifacts prove default table open stays bounded.
  - Acceptance: default table open uses this source and does not allocate all rows.

- [x] **3.3 Implement folder result source - 1.5**
  - Uses folder-filtered DB APIs.
  - Hydrates visible windows only.
  - Current state: no-query bookmark folder selections use this source for both single-folder and multi-folder scopes.
  - Current state: the source now tries persisted folder source index pages for cold random-access windows, uses sparse cursor checkpoints for progressive movement, and falls back to offset pages only when no current page map exists.
  - Verification: the live DB harness covers source behavior directly, and the 6k folder stress deep-index run verifies the built userscript path. Larger real/recovered DB QC remains tracked under migration/release gates, not source implementation.
  - Acceptance: folder selection changes active source descriptor and keeps memory bounded.

- [x] **3.4 Implement explicit selection source - 1.0**
  - Supports finite selected IDs.
  - Current state: explicit table selections expose their selected row ID set separately from the current visible records. Source-backed selected data exports create an `explicit-selection` result source, normalize composite table row IDs to hydration IDs, and stream through the same modal export pipeline as descriptor-backed result sets. The finite selected records array remains only as a fallback for non-source/imported table paths.
  - Verification: `npm run test:result-source-contract -- e2e/perf/out/result-source-contract-controller-audit.json` covers the standalone explicit selection source contract. `npm run test:export-modal-app -- e2e/perf/out/export-modal-app-selected-source-adapter.json` passed against the built userscript and verified selected JSON export streamed with `scope: "selected"`, exported two selected rows, emitted no selected array-export metric, preserved selected filenames, kept table hydration bounded at 80 rows, and recorded an `explicit-selection` result-source diagnostic.
  - Acceptance: explicit selected export does not require current visible table array ordering beyond the selected ID list.

- [x] **3.5 Implement search result source adapter - 1.0**
  - Short term: wraps lazy worker search results.
  - Long term: can wrap persisted search index results.
  - Current state: worker-backed search keeps its existing lazy corpus, readiness, cancellation, and bounded result limit semantics, then exposes the returned ordered ID list through a `search` result source adapter for current-session streaming. Search result exports can stream through the adapter without treating the bounded hydrated search records array as the export source of truth. This does not replace the future persisted inverted index.
  - Verification: `npm run test:result-source-contract -- e2e/perf/out/result-source-contract-controller-audit.json` covers the standalone search adapter contract. `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow-search-source-adapter.json` passed against the built userscript and verified active search export streamed through the search adapter, exported the two exact-phrase result rows, and recorded a `mode: "search"` result-source diagnostic with the worker-corpus descriptor.
  - Acceptance: search results have the same source interface as browsing/folders.

- [x] **3.6 Implement LRU page cache - 1.0**
  - Cache pages by source key and page/cursor.
  - Bound by page count and optionally approximate payload size.
  - Current state: capture, folder, and media result sources use the shared bounded `LruPageCache`; diagnostics expose `cachedPages`, `cachedRows`, and `lastCacheHit`. The default page limit is 10 and tests can lower it through `cachePages`.
  - Verification: `npm run test:db-source-live -- e2e/perf/out/db-source-live-lru-invalidation.json` passed with a two-page capture source cache. The harness touches one cached window, adds a third window, then verifies the least-recently-used window is evicted, the repeated evicted window is a miss, and diagnostics stay at `cachedPages: 2`, `cachedRows: 10`.
  - Acceptance: scrolling back a few pages is fast, but long sessions do not grow unbounded.

- [x] **3.7 Add source invalidation on mutation - 1.0**
  - Capture writes, clear operations, folder backfills, and imported data changes invalidate affected source keys.
  - Current state: source hooks include the DB mutation version in their source/window keys so table sources are recreated after writes. Persisted capture index pages carry per-extension/type source revisions; persisted folder source index pages carry descriptor/folder/count/revision keys. Capture writes, direct capture upserts, imports, clears, synthetic raw capture writes, search-document writes, folder-name backfills, and search-document clears invalidate the affected page maps.
  - Verification: `npm run test:db-source-live -- e2e/perf/out/db-source-live-lru-invalidation.json` passed with capture index invalidation after capture writes, delayed background capture-index rebuilds, folder source index background warmup, and cold deep folder windows served from current index pages with zero offset fallback. `npm run test:app-diagnostics-smoke` and `npm run test:small-dataset-workflow` provide app-level mutation/source refresh coverage.
  - Acceptance: table does not show stale counts after DB mutation.

- [x] **3.8 Add source diagnostics - 0.75**
  - Active source key, mode, total count, cached pages, cached rows, last fetch duration.
  - Acceptance: diagnostics bundle includes result source state.

- [x] **3.9 Add source-level unit tests - 0.75**
  - Captures, folders, selections, stale request handling.
  - Current state: source-level harness coverage exists for live capture sources, folder sources, media sources, explicit selection sources, and search-result source adapters. Stale async window handling is covered at the hook/app level under 2.8/5.4; source-level mutation invalidation is covered through index revision checks.
  - Verification: `npm run test:db-source-live -- e2e/perf/out/db-source-live-lru-invalidation.json` passed for capture cursor order, count, bounded hydration, sparse checkpoint behavior, cache hits, LRU eviction, folder/multi-folder windows, stream abort, media source windows/streams, capture index invalidation, and folder source index lifecycle. `npm run test:result-source-contract -- e2e/perf/out/result-source-contract-controller-audit.json` passed for explicit/search descriptors, ordered windows, cursor movement, stream abort, bounded hydration calls, and diagnostics.
  - Acceptance: tests cover page order, count, and bounded cache behavior.

### 4. Table Controller Replacement - 12 Points

- [x] **4.1 Design new table state shape - 1.0**
  - State should contain source descriptor, visible range, cached windows, selection descriptor, sort descriptor, search input, folder selection, and UI status.
  - It must not contain all result records for unbounded sources.
  - Acceptance: old `records`-as-authoritative-result-set concept is removed from the design.

- [x] **4.2 Split visible rows from result set - 1.5**
  - `visibleRows` are hydrated records for the current window.
  - `totalCount` is source metadata.
  - `selectedRows` are explicit finite hydrated records only when needed.
  - Current state: source-backed browsing derives `totalRows` from source metadata, computes the source window render slice from `sourceWindowStartIndex`, and feeds TanStack only `visibleRecords`. Descriptor-backed exports and media views receive streams/descriptors plus counts rather than treating the visible table array as the full result set. Explicit selected rows expose selected IDs separately and stream selected records through an explicit-selection adapter when source-backed.
  - Verification: `SCROLLMARK_DEEP_SCROLL_COUNT=100000 npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-100k-index-pages.json` proves 100k browsing keeps max hydrated records at 88, max result IDs at 88, and max visible rows at 64. `npm run test:export-memory-app -- e2e/perf/out/export-memory-app-100k.json` proves 100k export start/cancel keeps max hydrated records at 80 and result IDs at 80. `SCROLLMARK_MEDIA_MASONRY_COUNT=12000 npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-12k-source-export.json` proves the media modal uses source media rows while table hydration stays at 80. Current code search confirms `BaseTableView` passes `visibleRecords` into the table data model in source browsing and only passes streams/counts to large-result modals.
  - Acceptance: rendering works with visible rows plus row IDs, not full sorted records.

- [x] **4.3 Replace `useCapturedRecords` usage in table view - 1.5**
  - Table view should request a default result source instead of raw records.
  - Acceptance: table opens without `useCapturedRecords` appending pages into state.

- [x] **4.4 Remove automatic `useSearchDocuments` table-open dependency - 1.5**
  - Replace with facet/count hooks.
  - Search docs should load only for explicit search paths that need them.
  - Current state: table open and no-query source-backed folder selection keep search documents at 0 in app diagnostics and folder stress harnesses.
  - Verification: `npm run test:app-diagnostics-smoke` passed against the built userscript and exported diagnostics with `viewer:table-search-documents:value` at 0 after table open/mutation and `search:worker-corpus-candidates:value` at 0 while no query was active. `rg` confirms the Bookmarks table calls `useSearchDocuments(name, type, false)` and the controller invokes `loadSearchDocuments` only when `hasSearchQuery` is true.
  - Note: search-plus-folder still intentionally uses the lazy search-document/worker path until persisted search is implemented; that is tracked under the search strategy, not table-open removal.
  - Acceptance: table open does not call full `extGetSearchDocuments`.

- [x] **4.5 Replace full `recordById` maps - 1.0**
  - Keep maps only for visible rows and bounded hydrated search/selection rows.
  - Current state: `table-record-lookup-ids` diagnostics report lookup-map size separately from hydrated source rows. `test:app-diagnostics-smoke` verified the actual app stayed at 397 lookup IDs from 160 source-window records through table open, multi-folder source routing, and mutation. `test:export-modal-app` verified export paths stayed at 417 lookup IDs from 160 source-window records while exporting 1200 descriptor-backed rows.
  - Acceptance: diagnostics show map size remains bounded during browsing.

- [x] **4.6 Replace full `sortedRecords` derivation - 1.0**
  - Sorting should update source descriptor where DB-backed.
  - Client-side sorting is allowed only for bounded search result pages or visible cache.
  - Current state: source-backed browsing disables column sorting when only a bounded window is hydrated; `test:export-modal-app` clicks a table header and verifies the table remains descriptor-backed at `rendered 80/1200` instead of collapsing to the visible window.
  - Current state: in source browsing, `sourceBrowsingActive` bypasses finite virtual offsets and uses source metadata for height/count. `sortedRecords` remains only as a bounded helper for finite source windows, bounded worker search results, selected/fallback arrays, and imported bundle usage. If a source-backed unbounded table receives a sorting change, the controller clears the sort and records `viewer/source-sort-cleared` rather than sorting the current page as if it were the whole result set.
  - Verification: `npm run test:export-modal-app -- e2e/perf/out/export-modal-app-selected-source-adapter.json` verifies a source-backed column sort click does not sort only the visible window and export paths remain streamed/bounded. The 100k deep-scroll/export-memory artifacts verify `table-result-ids`, `table-hydrated-records`, and lookup IDs stay bounded while browsing/exporting descriptor-backed results.
  - Acceptance: default no-sort path does not clone/sort all loaded records.

- [x] **4.7 Replace full result ID snapshots - 1.0**
  - Result snapshots should store descriptors plus optional finite ID lists.
  - Current state: source-backed all-result snapshots store the `ResultSourceDescriptor`, total match count, and zero visible-window IDs. Non-source fallback snapshots are hard-capped at 5000 IDs and record `idsTotalCount` plus `idsTruncated` so a regression cannot silently clone 100k IDs into modal state.
  - Verification: `npm run test:result-set-lookup` creates a 100k-ID fallback input and verifies the snapshot stores only 5000 IDs; it also verifies a 100k descriptor-backed folder snapshot stores no IDs. `npm run test:export-modal-app` passed after this change against the actual modal/export flow.
  - Acceptance: snapshot for "all 100k bookmarks newest-first" does not contain 100k IDs.

- [x] **4.8 Replace selection mode semantics - 1.0**
  - `all` means "all rows matching descriptor", not "all rows in array".
  - Explicit deselections from all-mode must be represented as bounded exceptions or force explicit mode with confirmation if huge.
  - Current state: all-mode row deselection keeps `selectionMode: "all"` and stores only bounded exception IDs; `test:export-modal-app` verifies a 1200-row source-backed table stays at `selected 1199 (all)` after one deselection, and `SCROLLMARK_EXPORT_MODAL_COUNT=10000 npm run test:export-modal-app` verifies the same behavior at 10k rows.
  - Acceptance: selection UI remains correct without full result IDs.

- [x] **4.9 Preserve action modal contracts through adapters - 1.0**
  - Existing modals can receive visible rows where appropriate.
  - Export modals receive result source descriptors.
  - Current state: `ExportDataModal` accepts independent result-set and selected-record streams, so source-backed all-results/all-minus-exception exports, explicit selected exports, and active search-result exports no longer require a full result array. `ExportMediaModal` now accepts the DB-indexed media result stream for source-backed tweet result sets, scans media-bearing rows into media URL rows asynchronously, reports source scan progress, and no longer disables large source-backed bookmark media export when the media source exists. Finite visible/selected arrays remain only for small, selected, and non-source/imported fallback paths.
  - Verification: `npm run test:export-modal-app -- e2e/perf/out/export-modal-app-selected-source-adapter.json` passed with all-results streaming, all-minus-one descriptor-backed streaming, explicit selected streaming through the selection source adapter, bundle stream/cancel coverage, and bounded table/search state. `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow-search-source-adapter.json` passed with search-result export streaming through the search source adapter. `SCROLLMARK_MEDIA_MASONRY_COUNT=12000 npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-12k-source-export.json` passed with the media export modal open above 10k, `media-export-source-scan` diagnostics, 1715 source-scanned media URLs, 80 max table-hydrated rows, and 0 search documents.
  - Acceptance: no modal silently reintroduces full result arrays.

- [x] **4.10 Controller tests - 1.5**
  - Test default browsing, folder switch, rapid query changes, deep scroll, selection all, explicit selection, and source invalidation.
  - Current state: controller behavior is covered by app-integrated browser harnesses against the built userscript. `npm run test:export-modal-app -- e2e/perf/out/export-modal-app-controller-refresh.json` verifies source-backed sort clicks do not sort only the visible window, all-mode row deselection remains descriptor-backed, all-minus-one result export streams from the source with one exclusion, header selection moves between all and explicit modes, explicit selected export remains finite, and export paths do not hydrate the full table or load search documents. `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow.json` verifies default browsing, folder filtering, search ready/clear transitions back to all-results source mode, and mutation invalidation while the table is open. Existing `test:search-cancellation-app` and `test:deep-scroll-app` cover rapid query changes and deep source-window scroll scheduling.
  - Verification: `npm run test:export-modal-app -- e2e/perf/out/export-modal-app-controller-refresh.json`, `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow.json`, `npm run lint`, `npx tsc --noEmit`, and `git diff --check` passed in the controller-coverage slice.
  - Acceptance: tests fail if table state materializes unbounded arrays.

### 5. Virtualization And Scrolling - 9 Points

- [x] **5.1 Replace loaded-row-count virtual height with total-count virtual height - 1.5**
  - Virtualizer should use `source.totalCount`, not `sortedRecords.length`.
  - Current state: source browsing computes `totalRows` from `Math.max(totalCount, records.length)`, derives `totalVirtualHeight` from `totalRows * safeRowHeight`, and skips the finite `virtualOffsets` allocation. The rendered records are sliced from the current hydrated source window, not used as the total scroll height.
  - Verification: `npm run test:variable-height-table -- e2e/perf/out/variable-height-table-row-height-cache.json` passed with top/middle/bottom samples showing `rows 48/720`, `rows 79/720`, and `rows 50/720` while the scrollbar moved through windows `1-30`, `336-390`, and `683-720`. Existing 100k deep-scroll evidence reaches window `92047-92110` with only 88 hydrated rows.
  - Acceptance: scrollbar represents the full result set before all rows are visited.

- [x] **5.2 Support estimated heights for unseen rows - 1.0**
  - Use a stable estimate based on density/view type.
  - Current state: source browsing uses `safeRowHeight`, initialized from `VIRTUAL_INITIAL_ROW_HEIGHT` and smoothed from measured rendered-row averages. Unseen source rows use that estimate for top/bottom spacer math; finite mode can use measured per-row offsets.
  - Verification: `npm run test:variable-height-table -- e2e/perf/out/variable-height-table-row-height-cache.json` passed on variable-height rows up to 337px tall. Normal and fullscreen top/middle/bottom/deep samples had no row overlaps and no persistent gaps, while scroll heights stayed in a narrow range around 92.5k-92.8k px for 720 variable-height rows.
  - Acceptance: initial virtual height is stable enough to avoid repeated dramatic jumps.

- [x] **5.3 Persist measured heights by row ID in bounded cache - 1.0**
  - Keep measured heights for recently seen rows.
  - Bound cache size.
  - Current state: `BaseTableView` stores measured row heights in `rowHeightsRef` keyed by virtual row key, updates `touchedAt` on reuse, and trims through `trimRowHeightCache()` when the cache exceeds `ROW_HEIGHT_CACHE_LIMIT` 2500. The table now emits `viewer/table-row-height-cache` metrics whenever the measured cache changes.
  - Verification: `npm run test:variable-height-table -- e2e/perf/out/variable-height-table-row-height-cache.json` passed with `table-row-height-cache` events at 43, 98, 136, and 193 entries, every event reporting `limit: 2500`, and no geometry overlaps/gaps in normal or fullscreen scroll samples.
  - Acceptance: scrolling around recently seen rows preserves layout without unbounded height memory.

- [x] **5.4 Implement window request scheduler - 1.5**
  - Given scroll range, request visible page plus overscan.
  - Deduplicate overlapping requests.
  - Cancel or ignore stale requests.
  - Current state: source-backed capture and folder browsing coalesce overlapping scroll-driven window requests while a previous window is in flight, keep only the latest requested window, and emit explicit coalescing/stale-ignore metrics.
  - Verification: `npm run test:deep-scroll-app` opens the actual Bookmarks table with 10k complete-mode synthetic rows, scrolls to the middle, then rapidly scrolls through quarter/middle/bottom with a diagnostics-only source-window delay. The harness verifies obsolete capture-window requests are coalesced, stale completions are ignored, the final bottom window renders, and hydrated/result/search-document state remains bounded.
  - Acceptance: fast scrolling does not queue a long chain of obsolete DB requests.

- [x] **5.5 Add jump/deep-scroll behavior - 1.0**
  - If user drags far down, fetch by estimated index with offset fallback only if unavoidable.
  - Prefer anchor maps, sparse checkpoints, or cursor checkpoints for very deep jumps.
  - Current state: source-local checkpoints cover progressive deep scrolling after nearby windows have been visited.
  - Current state: capture sources now reuse the capture-count snapshot before falling back to a Dexie count scan, and the initial table fetch hydrates 80 rows instead of 160.
  - Current state: capture index pages now provide a persisted fixed-size ID page map for synthetic complete-mode captures. The source tries this index before source-local checkpoints or Dexie `offset()` fallback.
  - Current state: capture index pages now have a production lifecycle: per-extension/type revision guards, invalidation on capture writes/imports/clears, explicit rebuild API, and delayed background builds when an old DB is missing a current page map.
  - Current state: folder sources now have the same high-level random-access shape: persisted fixed-size row-ID pages first, source-local checkpoints second, and offset fallback only when no current page map exists. The folder page map is keyed by serialized source descriptor/folder scope plus count/revision.
  - Verification: `SCROLLMARK_DEEP_SCROLL_COUNT=100000 npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-100k-index-pages.json` passed with the 100k middle jump at 15.2ms, the bottom jump at 6.6ms, max DB event at 77.6ms, max 88 hydrated records/result IDs, max 176 lookup IDs, max 64 visible rows, and max long task 192ms.
  - Verification: `npm run test:db-source-live` verifies capture index-page build, invalidation, and delayed background build behavior; `npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-10k-index-lifecycle.json` verifies the built userscript path after the lifecycle changes.
  - Current state: recovered real DB QC now passes in both fake IndexedDB and Chromium browser harnesses for the 25 MB v6 export.
  - Current decision: first-release random-access precision is estimated before unseen rows are visited. The required behavior is that the table lands on the requested logical range after the DB source window returns, stays bounded, and does not sequentially load from row 0. Exact previsit pixel-perfect row placement is not required.
  - Verification: `SCROLLMARK_FOLDER_STRESS_SCENARIOS=huge SCROLLMARK_FOLDER_STRESS_HUGE=5000 SCROLLMARK_FOLDER_STRESS_RAPID_SCROLL=1 npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-5k-rapid-stale.json` passed with folder rapid-scroll actions to 25%, 50%, and 82%, final folder window start 4062/5000, folder stale suppression, and bounded cached rows.
  - Acceptance: jumping near row 80k does not require sequentially loading every page from row 0.

- [x] **5.6 Handle keyset vs random access tradeoff - 1.0**
  - Keyset is best for sequential browsing.
  - Random index jumps need sparse cursor checkpoints or temporary offset lookup.
  - Document chosen behavior.
  - Current state: the implementation has three capture paths in priority order: persisted capture index pages when present and count-matched, source-local cursor checkpoints for progressive movement, then bounded Dexie offset fallback when no persisted/random-access index is available.
  - Current state: folder result sources now use the same priority order with descriptor-scoped persisted folder source index pages, then source-local cursor checkpoints, then bounded offset fallback.
  - Current state: count snapshots are now trusted for active snapshot reads in module counters, preventing empty module cards from launching repeated high-count Dexie count scans during table open.
  - Current state: capture index-page creation is generalized beyond synthetic seeds through `extBuildCaptureIndexPages`; missing maps schedule a delayed background build, and stale maps are rejected through source revisions.
  - Current decision: sequential/progressive movement uses keyset/cursor checkpoints; cold random access uses persisted index pages when current, then source-local checkpoints when close enough, then bounded offset fallback only while an optional page map is absent. Missing maps warm in the background and stale maps are rejected by source revisions.
  - Verification: `npm run test:db-source-live -- e2e/perf/out/db-source-live-lru-invalidation.json` verifies capture/folder index-page lifecycle, current index-page deep folder windows, and stale index invalidation. `SCROLLMARK_DEEP_SCROLL_COUNT=100000 npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-100k-index-pages.json` verifies app-integrated 100k capture middle/bottom windows through the index-page path. `SCROLLMARK_FOLDER_STRESS_SCENARIOS=huge SCROLLMARK_FOLDER_STRESS_HUGE=6000 SCROLLMARK_FOLDER_STRESS_DEEP_INDEX=1 npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-6k-index-pages.json` verifies the built userscript folder deep-index path.
  - Acceptance: no hidden assumption that keyset alone solves all random access.

- [x] **5.7 Add scroll performance tests - 1.0**
  - Simulate scrolling to top, middle, bottom with 100k synthetic rows.
  - Current state: `npm run test:deep-scroll-app` provides app-integrated top/middle/bottom scroll coverage, validates source-window coalescing/stale suppression, fails on table main-thread stalls above 250ms, and records visible-row/hydrated/result/search-document bounds.
  - Verification: `npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-10k-initial80.json` passed with 10000 complete-mode capture rows, no search documents, max 64 visible rows, max 88 hydrated records/result IDs, max 176 lookup IDs, and max long task 175ms.
  - Verification: `SCROLLMARK_DEEP_SCROLL_COUNT=100000 npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-100k-initial80.json` passed with 100000 complete-mode capture rows, no search documents, max 64 visible rows, max 88 hydrated records/result IDs, max 176 lookup IDs, and max long task 191ms.
  - Verification: `npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-10k-index-pages.json` passed after capture index pages with middle/bottom windows at about 11ms, max DB event 75ms, and max long task 131ms.
  - Verification: `SCROLLMARK_DEEP_SCROLL_COUNT=100000 npm run test:deep-scroll-app -- e2e/perf/out/deep-scroll-app-100k-index-pages.json` passed after capture index pages with middle window 15.2ms, bottom window 6.6ms, max DB event 77.6ms, max long task 192ms, and bounded table state.
  - Note: the remaining release risk is not table-code scrolling or synthetic capture cold jumps; it is production index lifecycle for live/imported DBs plus equivalent folder-source cold random access.
  - Acceptance: no multi-second browser freeze from table code.

- [x] **5.8 Verify variable-height row correctness - 1.0**
  - Long text rows, media rows, compact/fullscreen rows, and translated UI.
  - Current state: synthetic bookmark seeding accepts `contentProfile: "variable-heights"` to generate long wrapped content and media-thumbnail rows without affecting default fixtures. `npm run test:variable-height-table -- e2e/perf/out/variable-height-table.json` opens the built userscript with Chinese UI, seeds 720 variable-height bookmarks, samples normal top/middle/bottom and fullscreen top/deep scroll positions, verifies rendered rows have no overlaps or persistent gaps, verifies tall/media rows are present, verifies translated table labels render, verifies visible rows stay bounded, and fails on long table stalls above 250ms.
  - Verification: `npm run build`, `npm run test:variable-height-table -- e2e/perf/out/variable-height-table.json`, `npm run lint`, `npx tsc --noEmit`, and `git diff --check` passed.
  - Acceptance: visible rows do not overlap or leave large persistent gaps.

### 6. Folder Facets And Bookmark Metadata - 6 Points

- [x] **6.1 Replace in-memory folder option computation - 1.0**
  - Current folder options loop over records or all search docs.
  - Replace with DB facet API.
  - Current state: Bookmarks `TableView` calls `useSearchDocumentFolderFacets` and passes the facet summary into `useBookmarkFolderUiState`; folder options are generated from `summary.facets`, not `records` or full `searchDocuments`, when the summary exists. The records fallback remains only for non-Bookmarks or missing-summary compatibility.
  - Verification: `npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-facet-ui.json` verifies the built app renders one huge-folder option from a DB facet event with `totalDocuments: 5000`, renders a capped 250 options plus filter input from a 2000-facet DB summary, and keeps `table-search-documents` at 0.
  - Acceptance: folder dropdown renders without loading all search docs.

- [x] **6.2 Replace bookmark status counts - 1.0**
  - Compute `api-name`, `id-only`, and `none` counts via DB cursor/facet logic.
  - Current state: `useBookmarkFolderUiState` copies `summary.statusCounts` directly into the folder metadata badge when the DB facet summary is present, so the badge no longer depends on the currently hydrated table rows for Bookmarks.
  - Verification: `npm run test:db-source-live` verifies DB facet summaries preserve `api-name`, `id-only`, and `none` counts before and after folder-name backfill. `npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-facet-ui.json` verifies the same facet path powers the built-app folder UI without loading search documents.
  - Acceptance: status widget matches existing behavior on small datasets.

- [x] **6.3 Define folder label precedence - 0.75**
  - API folder name wins.
  - ID-only fallback labels remain stable.
  - Backfilled names update facets.
  - Current state: `docs/db-backed-table-architecture-notes.md` records the precedence rule, and `npm run test:db-source-live` verifies mixed id-only/API folder rows promote the facet label/status to the API name while preserving ID-only fallback labels and unfiled counts.
  - Acceptance: documented and tested.

- [x] **6.4 Support huge single-folder case - 1.0**
  - One folder with 100k rows should page normally.
  - Current state: built-app folder stress passes at 5k one-huge-folder bookmarks with bounded cached rows and no search-document hydration.
  - Current state: `SCROLLMARK_FOLDER_STRESS_SCENARIOS=huge SCROLLMARK_FOLDER_STRESS_HUGE=10000 npm run test:folder-source-stress` passed with 10000 rows in one folder, 240 cached source rows, and zero table search-document hydration.
  - Current state: `SCROLLMARK_FOLDER_STRESS_SCENARIOS=huge SCROLLMARK_FOLDER_STRESS_HUGE=50000 npm run test:folder-source-stress` passed with 50000 rows in one folder, 240 cached source rows, and zero table search-document hydration. The 50k synthetic seed took 380.8s; the first 50k folder window took 5.16s before the folder-count index fix, while a post-fix 10k regression window dropped to 298ms.
  - Current state: `SCROLLMARK_FOLDER_STRESS_RAW_RECORD_MODE=source-window SCROLLMARK_FOLDER_STRESS_SCENARIOS=huge SCROLLMARK_FOLDER_STRESS_HUGE=100000 npm run test:folder-source-stress` passed with 100000 logical rows in one folder, 1000 stored raw tweets, 240 cached source rows, and zero table search-document hydration. This proves the 100k source-index/window path, not full raw-record/export coverage. A later complete-mode 10k regression after facet-known totals showed first folder window latency at 157ms.
  - Verification: `SCROLLMARK_FOLDER_STRESS_RAW_RECORD_MODE=source-window SCROLLMARK_FOLDER_STRESS_SCENARIOS=huge SCROLLMARK_FOLDER_STRESS_HUGE=100000 SCROLLMARK_FOLDER_STRESS_DEEP_INDEX=1 npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-huge-100k-source-window-deep-index.json` passed with 100000 logical rows in one folder, a deep scroll to source start index 86029, 88 hydrated rows served through a persisted `folder-source-index-page`, 168 cached source rows, zero table search-document hydration, one DB facet over 100000 documents, max folder-window duration 1504.5ms, and no page errors. Synthetic source-window raw retention now keeps sparse one-huge hydration bands so deep source-window probes can render rows without storing every raw tweet; the seed still took about 891s, so routine coverage uses the faster synthetic matrix and recovered-import paths unless this slow browser stress needs to be re-run.
  - Current state: the 25 MB recovered v6 export now passes real browser QC through Chromium IndexedDB and proves recovered capture/folder browsing stays source-backed and bounded. Browser seed cost is still too high for routine complete-mode 100k folder gates.
  - Acceptance: selecting that folder does not load all folder rows.

- [x] **6.5 Support many-folder case - 1.0**
  - Thousands of folders should not make the dropdown unusable.
  - Consider search/filter within folder picker if needed.
  - Current state: built-app folder stress passes at 5k many-small-folder bookmarks; the picker renders the capped 250 options and exposes the filter input.
  - Current state: `SCROLLMARK_FOLDER_STRESS_SCENARIOS=many SCROLLMARK_FOLDER_STRESS_MANY=10000 npm run test:folder-source-stress` passed with 10000 rows across 2000 folders; the picker rendered the capped 250 options, exposed the filter input, and selected-folder browsing stayed source-backed with zero table search-document hydration.
  - Verification: `SCROLLMARK_FOLDER_STRESS_RAW_RECORD_MODE=source-window SCROLLMARK_FOLDER_STRESS_SCENARIOS=many SCROLLMARK_FOLDER_STRESS_MANY=100000 npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-many-100k-source-window.json` passed with 100000 logical bookmark rows across 2000 folders, 250 capped rendered folder options, one folder filter input, a 50-row selected-folder source backed by 98 cached rows, zero table search-document hydration, and a 38.2ms max folder-window duration. The seed still took about 693s, so routine coverage uses the faster synthetic matrix and recovered-import paths unless this slow browser stress needs to be re-run.
  - Acceptance: facet UI remains responsive with synthetic many-folder data.

- [x] **6.6 Add folder regression tests - 1.25**
  - Missing names, mixed names, strict folder captures, folder backfills.
  - Current state: `npm run test:db-source-live` covers missing/unfiled rows, id-only rows, API-named rows, and mixed id-only/API rows for a single folder. The same harness now verifies folder-name backfill updates raw tweets, search documents, facet labels, and status counts.
  - Current state: `npm run test:bookmarks-strict-folder` verifies strict folder mode drops mismatched explicit folder requests, drops requests without folder evidence, and accepts matching requests while stamping trusted folder metadata into raw tweets and search documents.
  - Acceptance: tests pass against synthetic data.

### 7. Search Strategy - 12 Points

- [x] **7.1 Stop eager search corpus warming - 1.0**
  - Remove table-open worker corpus warmup.
  - Warm only after non-empty query or explicit search intent.
  - Current state: `shouldPrepareWorkerCorpus` is gated by `hasSearchQuery`, `recordCorpusRows` returns an empty corpus without a query, and empty-query folder/source browsing keeps worker corpus candidates at 0.
  - Verification: `npm run test:app-diagnostics-smoke` passed against the built userscript with `search:worker-corpus-candidates:value` at 0 and `viewer:table-search-documents:value` at 0 during table open, no-query folder selection, and source mutation. Existing 100k deep-scroll app coverage also opens and scrolls the table with zero search documents.
  - Acceptance: table open with 100k rows creates no full search corpus.

- [x] **7.2 Lazy-load search documents for worker search - 1.5**
  - When user searches, load/search corpus in worker path.
  - Show clear progress and allow cancellation.
  - Current state: table open still keeps search documents at 0. On first query, `useSearchDocuments` counts the corpus; below the threshold it can use the existing full worker corpus path, and above the threshold it leaves React table state empty and streams DB pages into the search worker in 1000-document chunks. Query changes cancel both worker work and the DB paging loop.
  - Verification: `SCROLLMARK_SEARCH_THRESHOLD_COUNT=60000 SCROLLMARK_SEARCH_THRESHOLD_COUNT_OVERRIDE=0 SCROLLMARK_SEARCH_THRESHOLD_RAW_RECORD_MODE=source-window SCROLLMARK_SEARCH_THRESHOLD_QUERY_TIMEOUT_MS=240000 npm run test:search-threshold-app -- e2e/perf/out/search-threshold-app-60k-real-chunked.json` passed against the built userscript with 60000 real search documents, 60 chunk transfers, `viewer:table-search-documents` max 0, `corpusSize: 60000`, and no page errors. `npm run test:search-cancellation-app -- e2e/perf/out/search-cancellation-app-chunked.json` passed after the worker contract change.
  - Acceptance: first search can be slower, but table open remains fast.

- [x] **7.3 Add search corpus threshold behavior - 1.0**
  - Below threshold, existing worker corpus is fine.
  - Above threshold, show indexed-search preparation state or use chunked corpus transfer.
  - Current state: above-threshold search no longer uses the blocked/degraded UI path in normal app search. The legacy blocked-reason helper remains covered for diagnostics, but the live table path records `large-corpus-chunked-load-required`, streams search-document pages to the worker, commits the worker corpus, and then queries it.
  - Verification: `npm run test:search-threshold-app -- e2e/perf/out/search-threshold-app-chunked.json` passed with the diagnostic 50500 count override and no blocked/degraded state; the real 60000-document run above passed without the override.
  - Acceptance: no silent browser hang when user searches a massive corpus.

- [x] **7.4 Preserve current search semantics in short term - 1.5**
  - Operators, phrases, slop, boolean logic, scoring, highlights, folder filters, and warnings remain intact for worker-backed search.
  - Current state: `npm run test:search-phrase-quality` covers unquoted phrase ranking, quoted exact phrase enforcement, slop phrase matching, `@handle` author shorthand, exact-phrase score precedence over high engagement bag-of-words rows, boolean `OR` plus `NOT`, quoted folder-name filters, worker option folder scopes, `has:media` presence filters, highlights, and invalid-filter warnings.
  - Implementation note: quoted known filters such as `folder:"Research Revisit 02"` are parsed as filters instead of field-scoped free text, matching the documented search syntax. Search candidate anchoring is disabled for negative lexical queries so the optimization cannot prune rows before the full boolean evaluator applies `NOT`.
  - Acceptance: existing search tests pass.

- [x] **7.5 Add query cancellation - 1.0**
  - Cancel search document loading and worker queries when query/source changes.
  - Current state: worker-backed table search cancels the previous request when the debounced query/source key changes. `SearchWorkerClient` emits `query-cancel` metrics with whether the request was still pending, and a diagnostics-only `localStorage.twe_search_worker_request_delay_ms_v1` delay lets browser tests hold a query before it posts to the worker.
  - Verification: `npm run test:search-cancellation-app` opens the actual Bookmarks table, warms a normal 800-row search, delays the next worker query, changes the query while it is pending, verifies a pending cancellation, verifies the delayed stale query is cancelled before posting worker work, and verifies the final query returns to `search ready`.
  - Acceptance: rapid typing does not pile up stale full-corpus work.

- [x] **7.6 Design persisted inverted index - 1.5**
  - Tables may include documents, terms, postings, term positions, field metadata, doc ranking stats, and version metadata.
  - Include backfill, invalidation, and partial index status.
  - Acceptance: design doc section is complete before implementation begins.

- [x] **7.7 Decide persisted index MVP - 1.0**
  - Candidate MVP: token search plus filters and recency ranking.
  - Phrase/slop support requires positions.
  - Decide whether MVP must exactly match current semantics or can be opt-in.
  - Acceptance: explicit decision recorded.

- [x] **7.8 Implement persisted index only after lazy worker path is stable - 1.0**
  - Do not combine initial table rewrite with search engine rewrite unless the lazy worker path proves insufficient.
  - Current branch decision: do not implement the persisted inverted index in the first DB-backed table rewrite. `npm run test:search-performance` records direct engine prep/query metrics through 100k synthetic rows, and app-level above-threshold search now uses chunked DB-to-worker corpus preparation instead of the blocked legacy full-load path. A persisted inverted index remains a future optimization, not a first-release blocker.
  - Acceptance: branch decision recorded after metrics.

- [x] **7.9 Add search performance tests - 1.0**
  - Small, 10k, 100k synthetic corpora.
  - Query types: simple term, phrase, boolean, folder-scoped, no-match.
  - Current state: `npm run test:search-performance` generates 1k, 10k, and 100k synthetic corpora in process and records corpus preparation latency plus query latency for simple term, exact phrase, boolean with `NOT`, folder-scoped option, quoted folder filter query, and no-match queries. The latest local run recorded 100k prep at 7275.042ms and max 100k query latency at 329.598ms for the synthetic workload.
  - Acceptance: tests record corpus prep and query latency.

- [x] **7.10 Add search degradation UX - 0.5**
  - If a huge query needs indexing/preparation, show status and cancellation.
  - Current state: the table header now renders explicit readiness text such as `preparing search index`, `querying local index`, and `search degraded`. Above-threshold app search uses the preparing/querying/ready states while chunking DB pages into the worker; the degraded path remains for unavailable worker/error cases. `npm run test:search-threshold-app` verifies the actual table avoids the blocked warning, does not hydrate search documents, and records ready readiness after chunked preparation.
  - Acceptance: user is never left with a frozen table and no explanation.

- [x] **7.11 Define search readiness states - 1.0**
  - Represent search as explicit states: unavailable, idle, preparing corpus, ready, querying, degraded, cancelled, failed.
  - Include persisted-index readiness if that branch is chosen later.
  - Current state: `SearchReadinessPhase` now models `idle`, `unavailable`, `preparing-corpus`, `ready`, `querying`, `degraded`, `cancelled`, and `failed`. The controller emits `search/readiness-state` metrics with phase, corpus row count, document load flags, and cancellability; the table renders the current readiness label when a query is active.
  - Verification: `npm run test:search-threshold-app` observes `idle`, `preparing-corpus`, and `degraded` readiness phases through the real UI. `npm run test:search-cancellation-app` observes the `cancelled` phase during a pending rapid query change. Browser coverage for `failed` and worker-unavailable branches remains follow-up controller cleanup rather than a blocker for defining the state model.
  - Acceptance: table UI, diagnostics, and tests can distinguish "search has not been requested" from "search is preparing" and "search cannot run safely at this scale."

### 8. Export And Result Snapshots - 8 Points

- [x] **8.1 Replace `loadAll()` export path - 1.5**
  - Export should stream from active result source descriptor.
  - Current state: opening the export modal from the source-backed Bookmarks table does not grow table hydration; `test:export-modal-app` held table hydration to 160 rows while exporting 1200 all-results rows.
  - Verification: `SCROLLMARK_EXPORT_MODAL_COUNT=10000 npm run test:export-modal-app -- e2e/perf/out/export-modal-app-10k-refresh.json` passed against the built userscript. The all-results modal exported 10000 rows with `streaming: true`, all-minus-one exported 9999 rows with one bounded exception, and the only array export event was the explicit selected two-row path. Table hydration stayed at 160 rows, search documents stayed at 0, lookup IDs stayed at 320, and source diagnostics cached 1520 rows.
  - Acceptance: opening export modal does not load remaining table rows.

- [x] **8.2 Add streaming export API - 1.5**
  - Iterate DB pages and snapshot rows incrementally.
  - Support JSON, CSV, HTML, and bundle ZIP paths.
  - Current state: JSON/CSV/HTML use the async-row export path for all current results. Bundle ZIP now reads from the source stream and hands snapshots to the worker in back-pressured 100-row batches; the worker still accumulates serialized JSONL chunks and final ZIP bytes to create a single downloadable Blob.
  - Verification: `npm run test:export-stream-integrity -- e2e/perf/out/export-stream-integrity-refresh.json` passed for streamed JSON order, CSV escaping, HTML escaping/translated headers, and cancellation. `SCROLLMARK_EXPORT_MODAL_COUNT=10000 npm run test:export-modal-app -- e2e/perf/out/export-modal-app-10k-refresh.json` passed with 100 bounded 100-row bundle batches, `bundle-worker-stream-complete` at 10000 rows, and `bundle-worker-complete` reporting 10000 sent rows.
  - Acceptance: export progress advances without holding all source records in table state.

- [x] **8.3 Make export worker consume batches - 1.0**
  - Bundle export should accept streamed batches or staged temp data.
  - Current state: `export-worker-client.ts` uses a `ready-for-chunk` worker protocol and sends 100-row batches from an async row stream; `export-worker.ts` consumes those chunks through `createCanonicalBundleZipFromRows`. `test:export-modal-app` observed 12 bounded batch sends for a 1200-row ZIP and no `bundle-preworker-row-buffer` path.
  - Acceptance: bundle export does not require one huge `rows` array from UI.

- [x] **8.4 Redesign result set snapshot - 1.0**
  - Snapshot should include source descriptor, query, filters, sort, created time, total count, and optional finite explicit IDs.
  - Current state: `ResultSetSnapshot` includes source descriptor, query text, serialized sort, creation time, total match count, warnings, `idsTotalCount`, and a bounded optional ID list. Descriptor-backed all-results export snapshots carry the source descriptor rather than visible-window IDs; finite selected/search fallbacks cannot exceed the snapshot ID cap.
  - Verification: `npm run test:result-set-lookup` covers descriptor-backed and capped fallback snapshot behavior; `npm run test:export-modal-app` verifies the real modal still pins the result set and exports descriptor-backed rows.
  - Acceptance: all-results snapshot for 100k rows is small.

- [x] **8.5 Preserve selected export behavior - 0.75**
  - Explicit selected rows can remain finite ID lists.
  - All-mode export uses descriptor.
  - Current state: `test:export-modal-app` clears all-mode selection, selects two visible rows, and verifies selected JSON export writes exactly 2 rows through the finite selected path. The same harness verifies all-mode row deselection exports the descriptor result set minus one bounded exception as 1199 streamed rows with `excluded: 1`, and the 10k variant verifies 9999 streamed rows with `excluded: 1`.
  - Acceptance: selected export still works.

- [x] **8.6 Add export cancellation - 0.75**
  - User can cancel long exports.
  - Current state: `test:export-stream-integrity` covers cancellation for the normal async-row exporter helper. `test:export-modal-app` covers the actual modal paths: delayed all-results JSON stream cancellation after 2 rows with no partial file, and delayed bundle worker cancellation after one 100-row batch with no partial ZIP.
  - Acceptance: cancellation stops DB iteration and worker jobs.

- [x] **8.7 Add export integrity tests - 1.0**
  - Compare small dataset exports before and after rewrite.
  - Verify large export counts and folder metadata.
  - Current state: `test:export-stream-integrity` covers JSON/CSV/HTML streaming, escaping, translated headers, and cancellation; `test:export-modal-app` covers real modal all-results JSON count, explicit selected JSON count, and batched ZIP download creation; canonical bundle roundtrip and latency harnesses validate bundle manifest counts after the streaming serializer change.
  - Verification: `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow.json` verifies the built app exports all 180 small-dataset bookmark rows after folder/search/clear transitions. `npm run test:export-stream-integrity -- e2e/perf/out/export-stream-integrity-refresh.json` verifies streamed JSON/CSV/HTML integrity. `SCROLLMARK_EXPORT_MODAL_COUNT=10000 npm run test:export-modal-app -- e2e/perf/out/export-modal-app-10k-refresh.json` verifies 10000 all-result rows, 9999 all-minus-one rows, 2 explicit selected rows, and 10000 bundle worker rows.
  - Acceptance: exported row count matches source count.

- [x] **8.8 Add export memory test - 0.5**
  - Synthetic 100k export should not grow table state to 100k records.
  - Current state: app-level export memory coverage exists at 10k complete-record rows and 100k descriptor-backed source-window rows. The 10k run proves completed JSON and bundle row counts on full synthetic records; the 100k run proves export start/cancel paths do not inflate table-owned state.
  - Verification: `SCROLLMARK_EXPORT_MODAL_COUNT=10000 npm run test:export-modal-app -- e2e/perf/out/export-modal-app-10k-refresh.json` kept table hydration at 160 rows, search documents at 0, lookup IDs at 320, source cached rows at 1520, and bundle sends at 100 rows per batch while exporting 10000 logical rows.
  - Verification: `npm run test:export-memory-app -- e2e/perf/out/export-memory-app-100k.json` seeded a 100000-row capture source with `rawRecordMode: "source-window"` and no search documents, opened the Bookmarks table at `rendered 35/100000`, started a descriptor-backed JSON result-set export at 100000 rows and cancelled after 3 streamed rows with no download, started a bundle ZIP export at 100000 rows and cancelled after one 100-row worker batch with no ZIP download, and kept table hydration at 80 rows, search documents at 0, result IDs at 80, lookup IDs at 160, and capture source diagnostics at 342 cached rows.
  - Note: this completes the bounded UI-state acceptance for 100k export start/cancel. Full 100k completed ZIP memory/latency remains a worker/final-Blob stress target, not a table-state blocker, because browser ZIP construction still necessarily accumulates final ZIP bytes.
  - Acceptance: diagnostics confirm bounded UI state.

### 9. Alternate Views And Media - 5 Points

- [x] **9.1 Audit alternate views for full-array assumptions - 0.75**
  - Start with tweet media masonry.
  - Acceptance: all alternate view array assumptions listed.

- [x] **9.2 Create media result source - 1.25**
  - Page media candidates from DB/search docs or projected media metadata.
  - Hydrate visible media cards only.
  - Current state: `createMediaResultSource` pages media candidates from search-document indexes via `extGetSearchDocumentMediaCount` and `extGetSearchDocumentMediaCursorPage`, then hydrates only the page tweet IDs. New search documents carry top-level numeric `media_flag` so the media cursor can filter on media presence while preserving newest-first `observed_at_ms` order; the older `numeric_json.media_count` index remains as a bounded fallback for pre-existing documents without `media_flag`.
  - App state: `TableView` passes the DB-backed media stream and media total into `TweetMediaMasonry`. The masonry view still scans its active stream into cards, but the active stream is now already projected to media-bearing tweets rather than all result rows. A source-reset generation guard prevents async iterator races while media totals arrive.
  - Verification: `npm run test:db-source-live -- e2e/perf/out/db-source-live-media-index.json` verifies DB media counts, cursor pages, newest-first ordering, media result-source hydration/streaming, and bounded media source diagnostics. `npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-indexed.json` and `SCROLLMARK_MEDIA_MASONRY_COUNT=12000 npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-12k-indexed.json` passed against the built userscript. The 12k run used `db/search-document-media-cursor-page` events with `fallback: false`, scanned 162 media-candidate rows out of 1715 media candidates, kept table hydration at 80, and kept search documents at 0.
  - Acceptance: media view does not flatten all tweets into all media items.

- [x] **9.3 Preserve current masonry behavior for small datasets - 0.75**
  - Visual ordering, folder labels, media filtering, density controls.
  - Current state: source-backed masonry preserves the existing card rendering, ordering from the active source stream, density controls, and original-tweet attachment filtering for small/normal datasets.
  - Verification: `npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app.json` seeds 720 variable-height/media bookmarks, opens the actual Bookmarks table, switches to media masonry, verifies media cards render from the source stream, toggles compact and comfortable density, scrolls the masonry view, and completes with no page errors.
  - Acceptance: screenshots remain comparable.

- [x] **9.4 Add media large-count behavior - 1.0**
  - 100k tweets with media should scroll without flattening all items.
  - Current state: large source-backed masonry is no longer blocked at 10k and now consumes a DB-indexed media result source instead of scanning all source rows. Media export also consumes the DB-indexed media result stream for large source-backed result sets instead of using the visible table row array.
  - Verification: `SCROLLMARK_MEDIA_MASONRY_COUNT=12000 npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-12k-indexed.json` passed above the old large-result guard threshold with 12000 complete-mode synthetic bookmarks, 72 initial loaded media cards, 162 loaded media-candidate rows after scroll, 1715 total media candidates, 80 hydrated table rows, 0 search documents, and media DB cursor events using the non-fallback `media_flag` index. `SCROLLMARK_MEDIA_MASONRY_COUNT=12000 npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-12k-source-export.json` passed with source-backed media export preparation scanning 1715 media-source rows into 1715 media URLs while keeping table hydration at 80 and search documents at 0.
  - Verification: `SCROLLMARK_MEDIA_MASONRY_RAW_RECORD_MODE=source-window SCROLLMARK_MEDIA_MASONRY_CONTENT_PROFILE=dense-media SCROLLMARK_MEDIA_MASONRY_SKIP_EXPORT=1 SCROLLMARK_MEDIA_MASONRY_COUNT=100000 npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-100k-dense-source-window-no-export.json` passed with 100000 media candidates, 72 loaded media cards, 160 scanned media rows after scroll, non-fallback media cursor pages, 80 max hydrated table rows, 0 search documents, and no page errors. `SCROLLMARK_MEDIA_MASONRY_RAW_RECORD_MODE=source-window SCROLLMARK_MEDIA_MASONRY_CONTENT_PROFILE=sparse-media SCROLLMARK_MEDIA_MASONRY_COUNT=100000 npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-100k-sparse-source-window.json` passed the rare-media case with 101 media candidates out of 100000 logical rows and source-backed media export scanning 101 rows into 101 URLs while keeping table hydration at 80 and search documents at 0.
  - Acceptance: memory counters remain bounded.

- [x] **9.5 Add alternate view fallback rule - 1.25**
  - If an alternate view is not yet DB-backed, disable or clearly mark it for massive datasets rather than freezing.
  - Current state: the generic fallback rule still disables non-source-backed alternate views above the large-source threshold, but tweet media masonry now declares `sourceBacked: true` in both table paths and consumes the source stream incrementally instead of forcing a full records array.
  - Verification: `SCROLLMARK_MEDIA_MASONRY_COUNT=12000 npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-12k.json` verifies the actual media masonry button is enabled above 10k and the view opens without hydrating the full table or loading search documents.
  - Acceptance: no alternate view can trigger an accidental full-array load.

### 10. Compatibility, Migration, And Release Safety - 7 Points

- [x] **10.1 Preserve small dataset behavior - 1.0**
  - Existing workflows should feel unchanged for small archives.
  - Current state: `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow.json` opens the built userscript with a 180-row synthetic bookmark archive, verifies the Bookmarks table opens with visible rows, folder filtering still narrows rows, exact-phrase search reaches ready state, clearing search returns to descriptor-backed all-results mode, JSON export writes all 180 result rows, reseeding to 210 rows refreshes the open table/source diagnostics, and Clear empties the archive.
  - Regression fixed during verification: source result streaming now pages by result index for normal full-result exports and rejects non-zero sparse checkpoints that do not carry a real cursor, preventing indexed capture pages from truncating or duplicating small archive exports.
  - Verification: `npm run build`, `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow.json`, `npm run test:db-source-live`, `npm run lint`, `npx tsc --noEmit`, and `git diff --check` passed.
  - Acceptance: existing tests and manual smoke pass.

- [x] **10.2 Add feature flag or staged rollout switch - 1.0**
  - Allow old table path during development if needed.
  - Do not keep old path indefinitely after migration.
  - Current state: this was satisfied during rollout by `localStorage.twe_table_source_mode_v1 = "legacy"` and `npm run test:table-rollout-flag`. After the source-backed path reached its verification gate, item 11.4 removed the transitional flag, legacy `TableView` branch, legacy `useCapturedRecords` hook, and rollout harness.
  - Verification: historical rollout evidence remains in `e2e/perf/out/table-rollout-flag.json`; current single-architecture evidence is provided by `rg 'twe_table_source_mode_v1|table-rollout-mode|test:table-rollout-flag|table_rollout_flag|LegacyTableView|useCapturedRecords\\(' src e2e package.json --glob '!e2e/perf/out/**'` returning no live code/test/package references, plus current source-backed browser harnesses. Historical documentation may still mention the staged rollout and removal. After the removal, `npm run build`, `npm run test:app-diagnostics-smoke -- e2e/perf/out/app-diagnostics-smoke-single-source.json`, `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow-single-source.json`, `npm run test:export-modal-app -- e2e/perf/out/export-modal-app-single-source.json`, and `npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-single-source.json` passed against the single source-backed architecture.
  - Acceptance: staged rollout switch existed for local QC and is now removed as required by 11.4.

- [x] **10.3 Add DB version migration tests - 1.0**
  - Existing user DB opens after new indexes/tables.
  - Empty DB opens.
  - Synthetic old DB upgrades.
  - Current state: `npm run test:recovered-db-import -- e2e/perf/out/recovered-db-import-round019-small.json` uses `fake-indexeddb` plus a recovered v6 Dexie export from `misc/round_019/twitter-web-exporter-1779916291277.json`. It proves v6 export import compatibility with the current v9 schema, import-time index invalidation, recovered row-count preservation, recovered capture source windows, capture index-page build/read, recovered folder facets, and recovered folder persisted index pages.
  - Current state: `npm run test:db-migration-compat -- e2e/perf/out/db-migration-compat.json` opens an empty current DB, creates and upgrades a synthetic v6 DB, verifies it reaches the v9 IndexedDB schema, preserves capture/search-document rows, exposes folder facets, and can build/read capture index pages after upgrade.
  - Note: the larger 168 MB recovered export is now covered by the bounded import/source/index probe under 2.9; the explicit 10.3 migration-test acceptance is covered by empty DB, synthetic old DB, and recovered v6 export-import gates.
  - Acceptance: migration test passes.

- [x] **10.4 Protect current write/indexing fixes - 1.0**
  - The queued/chunked writes from `v1.0.1` must remain intact.
  - Current state: `npm run test:write-indexing-regression -- e2e/perf/out/write-indexing-regression.json` writes 1505 tweets through `extAddTweets`, overlaps a queued `extAddTweetCaptureIds` call, verifies capture/search-document/folder facet counts, builds capture index pages, then writes more tweets and verifies stale index pages are invalidated and rebuilt.
  - Acceptance: large indexing test still passes.

- [x] **10.5 Keep `1.0.2` hotfix isolated - 0.75**
  - Injection/bundling fix can ship independently.
  - Current state: `scripts/check-userscript-metadata.mjs` now validates release/store `@inject-into page`, version sync, bundled dependency output with no `@require`, GitHub release update/download URLs for the release artifact, and no update/download URLs for the store artifact.
  - Verification: `npm run build:all` rebuilt release, store, synced store copy, Firefox E2E, and Chrome E2E userscripts. `npm run check:metadata` validated all five generated/store artifacts.
  - Acceptance: table rewrite commits do not accidentally mix release metadata unless intended.

- [x] **10.6 Add release checklist for table rewrite - 1.0**
  - Manual QC on real export, synthetic 10k, synthetic 100k, search, folder filters, export, media view, clear/reset.
  - Current state: `docs/release/final-release-checklist.md` now has a dedicated DB-backed table rewrite section with automated preflight, source/DB contracts, app workflows, search gates, browser/scale smoke artifacts, manual QC steps, and stop conditions. `docs/release/publishing-runbook.md` points release authors to that section and adds DB-backed table post-release checks.
  - Verification: the checklist maps real/recovered-data QC, synthetic 10k/100k coverage, search, folder filters, export, media view, clear/reset, browser compatibility, and metadata gates to concrete commands or manual checks.
  - Acceptance: release checklist exists and is followed.

- [x] **10.7 Add rollback plan - 1.25**
  - Include how to disable new table source path if severe issue appears.
  - Include DB migration rollback constraints.
  - Acceptance: rollback plan is documented before release.

### 11. Cleanup And Deletion Of Old Model - 6 Points

- [x] **11.1 Remove or quarantine `useCapturedRecords` table usage - 1.0**
  - Keep only if other features need it and it is clearly bounded.
  - Acceptance: main table no longer uses it.

- [x] **11.2 Remove full `useSearchDocuments` table-open path - 1.0**
  - Keep explicit search/facet APIs only.
  - Acceptance: no table-open call to full `extGetSearchDocuments`.

- [x] **11.3 Remove full-array table controller assumptions - 1.0**
  - No unbounded `sortedRecords`, `selectedRecords`, `currentResultIds` for all-mode result sets.
  - Current state: all-mode selection no longer converts to a visible-window explicit map, result-set export streams from the active source while applying bounded exceptions, source-backed sorting is guarded, and `recordById` diagnostics prove the lookup map is bounded during source-backed browsing. `docs/db-backed-table-controller-audit.md` records the final controller array audit: remaining arrays are source-window bounded, explicit finite, lazy-search bounded, or capped fallback structures.
  - Verification: `rg -n 'sortedRecords|selectedRecords|currentResultIds|recordById|workerCorpusRows|virtualOffsets|ROW_HEIGHT_CACHE_LIMIT' src/components/table src/utils/result-set.ts` plus runtime artifacts from 100k deep-scroll/export-memory and recovered real-data browser QC. The audit also documents why `loadAll` remains only for the finite imported bundle viewer path and is not passed by the main source-backed `TableView`.
  - Acceptance: code search confirms old patterns are gone or bounded.

- [x] **11.4 Remove transitional feature flag - 1.0**
  - After release confidence, delete old path.
  - Current state: `TableView` now always uses the source-backed table path. Removed `localStorage.twe_table_source_mode_v1`, `viewer/table-rollout-mode`, `LegacyTableView`, the legacy `useCapturedRecords` hook/cache, `npm run test:table-rollout-flag`, and `e2e/perf/table_rollout_flag_harness.mjs`.
  - Verification: `rg 'twe_table_source_mode_v1|table-rollout-mode|test:table-rollout-flag|table_rollout_flag|LegacyTableView|useCapturedRecords\\(' src e2e package.json --glob '!e2e/perf/out/**'` has no remaining live-code, harness, or package references. Historical documentation may still mention the staged rollout and removal. `npm run build`, `npm run test:app-diagnostics-smoke -- e2e/perf/out/app-diagnostics-smoke-single-source.json`, `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow-single-source.json`, `npm run test:export-modal-app -- e2e/perf/out/export-modal-app-single-source.json`, `npm run test:media-masonry-app -- e2e/perf/out/media-masonry-app-single-source.json`, `npm run lint`, `npx tsc --noEmit`, and `git diff --check` pass after deletion.
  - Acceptance: one supported table architecture remains.

- [x] **11.5 Update developer docs - 1.0**
  - Explain result sources, DB queries, virtualizer, search, export.
  - Current state: `docs/db-backed-table-developer-guide.md` maps the source-backed table flow from `TableView` through hooks, result sources, DB manager APIs, controller state, virtualizer behavior, search, selection, export, diagnostics, and harnesses. `README.md` now lists the guide in the project map.
  - Verification: documentation-only change plus `git diff --check`.
  - Acceptance: a new contributor can follow the data flow.

- [x] **11.6 Final dead-code audit - 1.0**
  - Remove unused helpers, obsolete metrics, stale tests.
  - Current state: removed the obsolete legacy table hook/cache, rollout metric, rollout harness, and package script. The final audit found no live `LegacyTableView`, `useCapturedRecords`, rollout flag, rollout metric, rollout harness, or rollout package-script references outside historical docs.
  - Current state: the only remaining `BaseTableView.loadAll()` call path is the finite imported-bundle viewer, which is documented as outside the source-backed Bookmarks/Tweets/Users table rewrite. Search full-load blocking remains only as a diagnostic fallback guard; its user-facing message now points at chunked DB-to-worker high-count search as the normal path.
  - Verification: `rg 'LegacyTableView|useCapturedRecords\\(|twe_table_source_mode_v1|table-rollout-mode|table_rollout_flag|test:table-rollout-flag' src e2e package.json --glob '!e2e/perf/out/**'` returned no live matches. `rg 'loadAll\\(|loadAll=|loadMore=|useSearchDocuments\\([^\\n]*true|createSearchDocumentFullLoadBlockedReason|large-corpus-load-blocked|viewer/table-rollout-mode|table-search-documents' src e2e package.json --glob '!e2e/perf/out/**'` left only expected diagnostics, the documented imported-bundle `loadAll` path, the diagnostic search guard, and table-search-document gauge assertions.
  - Verification: `npm run test:search-threshold-guard`, `npm run lint`, `npx tsc --noEmit`, and `git diff --check` passed after the final cleanup.
  - Acceptance: lint/typecheck pass and code search is clean.

### 12. Verification Matrix - 5 Points

- [x] **12.1 Unit tests - 0.75**
  - DB APIs, result sources, descriptors, selection, snapshots.
  - Current state: `npm run test:db-source-live` covers live Dexie DB APIs, folder facets/counts, cursor pages, capture index-page build/invalidation/background-build lifecycle, folder source index background warmup, >5k cold deep folder windows served without offset fallback, known facet totals, sparse checkpoints, LRU cache eviction, media source windows/streams, and streaming aborts; `npm run test:result-source-contract` covers descriptor-backed explicit/search source contracts; `npm run test:result-set-lookup` covers lookup aliases, ordered hydration holes, descriptor-backed snapshots, and capped fallback snapshots; `npm run test:db-migration-compat` covers empty/current schema and synthetic v6 upgrade compatibility; `npm run test:write-indexing-regression` covers large chunked writes, queued rewrites, index-page parity, and invalidation; `npm run test:search-phrase-quality` covers the worker-backed advanced search semantic contract; `npm run test:search-performance` covers search prep/query performance measurement through 100k synthetic rows.
  - Verification: `npm run test:db-source-live -- e2e/perf/out/db-source-live-12-1-final.json`, `npm run test:result-source-contract -- e2e/perf/out/result-source-contract-12-1-final.json`, `npm run test:result-set-lookup -- e2e/perf/out/result-set-lookup-12-1-final.json`, `npm run test:db-migration-compat -- e2e/perf/out/db-migration-compat-12-1-final.json`, `npm run test:write-indexing-regression -- e2e/perf/out/write-indexing-regression-12-1-final.json`, `npm run test:search-phrase-quality -- e2e/perf/out/search-phrase-quality-12-1-final.json`, and `npm run test:search-performance -- e2e/perf/out/search-performance-12-1-final.json` all passed on 2026-06-03.
  - Acceptance: core DB/source/snapshot/search units and source contracts have focused automated coverage.

- [x] **12.2 Integration tests - 0.75**
  - Table open, folder filters, search, export, mutation invalidation.
  - Current state: `npm run test:small-dataset-workflow -- e2e/perf/out/small-dataset-workflow.json` covers the requested app-integrated workflow in the built userscript: table open, folder filter, exact-phrase search, result-set JSON export, live mutation invalidation/reseed while the table remains open, Clear reset, and source/search/export/db perf evidence with no page errors.
  - Supporting integration evidence also remains in focused browser harnesses for diagnostics smoke, export modal behavior, search threshold/degradation, rapid search cancellation, deep scroll, folder source stress, and recovered import compatibility.

- [x] **12.3 E2E synthetic large datasets - 1.0**
  - 10k, 50k, 100k, and at least one higher stress target.
  - Current state: 10k source-backed browsing, export modal, all-mode exception export, huge-folder, and many-folder browser paths have focused E2E proof; 50k one-huge-folder complete-mode app-integrated stress passes with bounded source cache/search-doc hydration; 100k one-huge-folder source-window app-integrated stress passes for source-index/window behavior; 100k many-folder source-window app-integrated stress passes for the facet picker/source path; 100k complete-mode capture deep-scroll app coverage passes with bounded source/render state and no table long task above 250ms; 100k export start/cancel memory coverage passes with bounded table state and 100-row bundle worker batches; broader 50k/100k/250k coverage exists for the standalone large-count smoke path.
  - Verification: `SCROLLMARK_FOLDER_STRESS_RAW_RECORD_MODE=source-window SCROLLMARK_FOLDER_STRESS_SCENARIOS=many SCROLLMARK_FOLDER_STRESS_MANY=100000 npm run test:folder-source-stress -- e2e/perf/out/folder-source-stress-many-100k-source-window.json` passed the 100k many-folder built-userscript path, and `VIEWER_HARNESS_MAX_RECORDS=250000 node scripts/large-count-smoke.mjs --count=250000 --browsers=chromium --out=e2e/perf/out/large-count-smoke-250k-chromium.json` passed the higher stress target with 250000 rows, 1120 loaded table rows, no page errors, no blank/duplicate/order violations, max long task 86ms, and p95 frame 16.8ms.

- [x] **12.4 Manual real-data QC - 0.75**
  - User's large bookmark export or recovered DB scenario.
  - Current state: the recovered round_019 v6 Dexie export is now exercised in the built userscript in Chromium, not only in fake IndexedDB.
  - Verification: `npm run test:recovered-db-browser -- e2e/perf/out/recovered-db-browser-round019.json` imported `/home/skra/projects/twitter_scraping/misc/round_019/twitter-web-exporter-1779916291277.json` through the built userscript into Chromium IndexedDB. The run verified v6 row counts after import (`tweets: 2798`, `captures: 7166`, `search_documents: 8526`), opened the real Bookmarks table for 415 recovered bookmark captures at `rendered 23/415`, rendered 19 recovered folder facet options from DB facets, selected a recovered 248-row folder source, rendered 20 folder rows, and kept table state bounded at 80 hydrated rows, 0 search documents, 80 result IDs, and 232 lookup IDs with no page errors.

- [x] **12.5 Browser compatibility - 0.75**
  - Violentmonkey, Greasemonkey/Tampermonkey where practical, Firefox/Chromium paths.
  - Current state: release/store/E2E artifact metadata is validated for release/store update URLs and local E2E injection shape, and the standalone scroll smoke now has current Chromium+Firefox coverage.
  - Verification: `npm run build:all && npm run check:metadata` rebuilt and validated `dist/scrollmark.user.js`, `dist/scrollmark.store.user.js`, `store/scrollmark.user.js`, `dist/twitter-web-exporter-e2e.user.js`, and `dist/twitter-web-exporter-chrome-e2e.user.js`. `node scripts/large-count-smoke.mjs --count=5000 --browsers=chromium,firefox --out=e2e/perf/out/large-count-smoke-5000-chromium-firefox.json` passed with both Chromium and Firefox: bounded table loaded rows at 1120/5000, no page errors, no blank or duplicate visible windows, large-folder masonry not trimmed to the loaded page, max Chromium long task 70ms, and Firefox p95 frame 17.3ms.
  - Verification: refreshed compatibility pass on 2026-06-03: `npm run build:all && npm run check:metadata` passed, and `node scripts/large-count-smoke.mjs --count=5000 --browsers=chromium,firefox --out=e2e/perf/out/large-count-smoke-5000-chromium-firefox-refresh.json` passed with Chromium and Firefox. The user also confirmed live Violentmonkey manager QC after the injection-metadata fix: Violentmonkey no longer showed the injection failure, and the widget plus squirrel button returned.
  - Note: Tampermonkey/Greasemonkey live-manager signoff remains a release-checklist/manual-QC item where practical, but the first-release browser-compatibility acceptance is covered by artifact metadata, browser-engine smoke, and the live Violentmonkey recovery confirmation.

- [x] **12.6 Diagnostics review - 0.5**
  - Confirm metrics prove no full load on open.
  - Current state: `test:app-diagnostics-smoke` exports the real diagnostics ZIP through `exportDiagnosticsBundleZip`, unzips `summary.json`, and verifies `result_sources` includes a 1200-row capture source with only 160 cached rows. The same bundled summary verifies performance counters include `table-record-lookup-ids` events and `table-search-documents:value` remains 0.

- [x] **12.7 Release artifact metadata review - 0.5**
  - Ensure userscript metadata, injection mode, and store artifact remain valid.
  - Current state: metadata validation covers release/store/E2E versions, `@inject-into`, update/download URLs, required grants/matches, and bundled output with no external `@require`.
  - Verification: `npm run build:all` and `npm run check:metadata` passed.

## Conditional Playbook

### If Table Open Is Still Slow After Removing Full Search Docs

Check in this order:

- Is first render blocked on DB count?
- Is first render blocked on facet calculation?
- Is first render blocked on hydration of too many tweets/users?
- Is table layout waiting for row measurement cycles?
- Is a worker being created or warmed?
- Is a modal/alternate view receiving all result rows?
- Is React/Preact state being updated multiple times with large payloads?

Actions:

- Defer facets until after first visible rows.
- Render count as pending if count is slow.
- Reduce initial hydrated window.
- Ensure search worker is not touched.
- Add instrumentation around each stage.

### If Deep Scroll Still Freezes

Check in this order:

- Is the page cache bounded?
- Are stale requests being ignored?
- Is a large offset query still being used?
- Is virtualizer recomputing arrays for total count on every scroll event?
- Is row measurement causing repeated full recalculation?
- Is a sort/filter path materializing all rows?

Actions:

- Add cursor checkpoints.
- Batch scroll updates with `requestAnimationFrame`.
- Cap simultaneous DB reads.
- Replace per-row full offset arrays with a sparse height model if needed.
- Add a hard diagnostic warning when loaded hydrated records exceed the expected bound.

### If Search Becomes The Main Bottleneck

Check:

- Is search corpus loaded only after query input?
- Is search document loading chunked?
- Is worker transfer cost dominating?
- Are phrase/slop semantics required for this query?
- Is the user searching within a folder, allowing smaller corpus scope?

Actions:

- Use folder scope to reduce corpus before search when selected.
- Add progress UI and cancellation.
- Consider chunked worker corpus preparation.
- If metrics still fail, start persisted inverted index workstream.

### If Export Requires Too Much Memory

Check:

- Is export receiving `resultRecords` or a descriptor?
- Is export format builder accumulating all rows before writing?
- Is bundle ZIP worker requiring one full array?
- Is metadata cloning duplicating large tweet objects?

Actions:

- Stream rows in batches.
- For formats that require one final Blob, accumulate serialized chunks, not hydrated source objects.
- Move heavy export transformation into worker batches.
- Add cancellation and progress.

### If DB Migration Is Risky

Check:

- Does new schema require backfilling every document before UI works?
- Can old data be read with degraded features?
- Can indexes be added without changing stored row shape?
- Can projected fields be populated lazily?

Actions:

- Ship read path first.
- Backfill lazily.
- Gate advanced features on index readiness.
- Keep diagnostics explicit about index state.

## Data Model Notes

### Captures

Captures provide source membership and observed order. They are the right default source for normal browsing.

Needed:

- Stable keyset cursor over extension, type, created time, and capture ID.
- Count by extension/type.
- ID-only page reads.
- Hydration by tweet/user IDs.

### Search Documents

Search documents provide lightweight metadata for facets, folder filters, and search corpus construction.

Needed:

- Count by extension/entity type.
- Facet aggregation by folder.
- Folder-filtered pagination by observed time.
- Optional projected sort keys.
- Eventually tokenized/inverted index tables if we want DB-native full-text search.

### Result Snapshots

Snapshots should describe the result set, not copy it.

Good snapshot:

```json
{
  "kind": "captures",
  "extensionName": "BookmarksModule",
  "entityType": "tweet",
  "sort": "observed_at_desc",
  "filters": {},
  "totalCount": 100000,
  "createdAt": 1770000000000
}
```

Bad snapshot:

```json
{
  "ids": ["100000 ids here"]
}
```

Finite explicit selections may use ID arrays. Unbounded "all results" must use descriptors.

## UI Behavior Targets

### Table Open

Expected visible stages:

1. Shell opens.
2. Count and first window request start.
3. First visible rows render.
4. Facets/status fill in.
5. Optional background cache warms only a small adjacent range.

The table should not visually update several times because it loaded 160 rows, then 480 rows, then 800 rows, then 960 rows, then all search docs, then a worker corpus.

### Scrolling

- Scrollbar reflects total result count.
- Visible rows load for requested range.
- Fast scroll may show skeleton rows briefly.
- Previously visited nearby rows should appear immediately from cache.
- Far jumps should not require sequential loading from the top.

### Folder Filtering

- Folder options come from facets.
- Selecting a folder swaps to a folder result source.
- Folder result count is available without loading all rows.
- Rows hydrate only for the visible window.

### Search

- Empty search does not use the search worker.
- Non-empty search starts explicit search preparation.
- Large search shows progress and can be cancelled.
- Search result source hydrates visible/top result rows only.

### Export

- Export modal opens without forcing all table rows to load.
- Export count comes from result source.
- Export all streams from DB.
- Selected export uses explicit finite IDs.
- Progress is based on streamed rows processed.

## Acceptance Gates

### Gate A: Ready To Start Table Controller Swap

Required completed items:

- 1.1 through 1.4
- 2.1 through 2.4
- 3.1 design complete

Gate question:

Can we prove the old bottlenecks and measure whether the new path avoids them?

### Gate B: Ready To Remove Array-Based Browsing

Required completed items:

- 2.2 keyset capture pagination
- 3.2 captures result source
- 4.1 through 4.4
- 5.1 through 5.4

Gate question:

Can the default table open and scroll without full records or full search docs?

### Gate C: Ready For Large Bookmark QC

Required completed items:

- 6.1 through 6.4
- 7.1 through 7.5
- 8.1 through 8.4
- 12.1 through 12.3

Gate question:

Can browsing, folder filtering, search, and export avoid freezing on 100k synthetic bookmarks?

### Gate D: Ready For Release Candidate

Required completed items:

- All compatibility and migration tasks.
- All verification matrix tasks.
- No known unbounded array path in table open, browsing, folder filtering, or export.
- Search limitations, if any, are explicit in UI and docs.

Gate question:

Would a user with a very large real bookmark DB see predictable behavior and have a rollback path?

## Open Decisions

- [x] What is the first target high-water synthetic dataset: 100k, 250k, or 1m?
- [x] Should persisted inverted search index be part of the first table rewrite release or a follow-up?
- [x] What sort columns must be DB-backed in the first release?
- [x] Should all-mode selection allow explicit deselection exceptions for huge result sets?
- [x] How much random-access scroll precision is required before rows are visited?
- [x] Should media masonry be blocked for huge datasets until it is source-backed, or rewritten in the first pass?
- [ ] What browser matrix is mandatory before publishing?

## First Implementation Slice Recommendation

Do not begin with the virtualizer. Begin by making full loads impossible on open.

Recommended first slice:

- Add metrics and synthetic seeding.
- Add DB count, facet, and keyset page APIs.
- Add a captures result source.
- Create a new table path behind a local feature flag.
- Render first visible window from the result source.
- Confirm no full search docs and no search worker corpus on open.

Only after that should we expand into folder result sources, export streaming, and search changes.

## Definition Of Done

The migration is done when:

- Opening Bookmarks with 100k synthetic rows renders first visible rows within the agreed budget.
- Opening Bookmarks does not load all captures, all tweets, or all search documents.
- Empty-query browsing does not initialize a full search worker corpus.
- Deep scroll remains responsive and keeps hydrated row count bounded.
- Folder filtering pages from DB and keeps memory bounded.
- Export all streams from the result source and does not call table `loadAll()`.
- Result snapshots for unbounded sets are descriptor-based.
- Existing small-dataset behavior remains intact.
- Diagnostics can prove all of the above.
- The old array-based table model is removed or quarantined from the main table path.
