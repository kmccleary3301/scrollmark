# DB-Backed Table Developer Guide

This guide explains the current source-backed table path. It is the implementation companion to `docs/db-backed-table-scalability-playbook.md` and `docs/db-backed-table-architecture-notes.md`.

## Target Invariant

The table must browse large archives from IndexedDB source descriptors instead of owning complete result arrays in component state.

Allowed bounded in-memory state:

- Rendered rows and the padded source window around them.
- LRU source page cache rows.
- Explicit finite selections.
- Search results after a bounded query path has intentionally loaded them.
- Small diagnostic fixtures when a harness proves the behavior is bounded.

Not allowed for unbounded source browsing:

- Full `records` arrays for the result set.
- Full sorted result arrays.
- Full selected hydrated rows when selection mode is `all`.
- Full result ID arrays for descriptor-backed all-results mode.
- Empty-query worker corpus construction.

## Runtime Flow

1. Module panels open `TableView` from `src/components/table/table-view.tsx`.
2. `TableView` always uses the source-backed path.
3. Capture browsing uses `useDbBackedCapturedRecords` from `src/core/database/hooks.ts`.
4. Bookmark folder browsing with no text query uses `useDbBackedFolderRecords`.
5. Both hooks create `ResultSource` objects from `src/core/database/result-sources.ts`.
6. `BaseTableView` requests source windows as the virtual scroll range changes.
7. `useResultSetController` owns search query state, folder selection state, row selection state, sorting state, and result-set snapshots.
8. `ExportDataModal` streams all current results from the active result source when a descriptor-backed source is active.
9. Diagnostics and performance metrics record source, table, search, export, and DB evidence for harnesses and user diagnostics.

## Key Files

| Area | File | Notes |
| --- | --- | --- |
| Table entry | `src/components/table/table-view.tsx` | Wires source-backed capture/folder/media hooks and passes source descriptors to `BaseTableView`. |
| Table shell | `src/components/table/base.tsx` | Virtual scrolling, visible rows, selection UI, action modals, table metrics. |
| Controller | `src/components/table/use-result-set-controller.ts` | Search readiness, folder/search transitions, sorting, selection mode, result snapshots. |
| DB hooks | `src/core/database/hooks.ts` | Preact state wrappers for source windows, lazy search documents, folder facets, count snapshots. |
| Result source contracts | `src/core/database/result-source.ts` | Serializable descriptors and result window interfaces. |
| Live sources | `src/core/database/result-sources.ts` | Capture and folder source implementations, sparse checkpoints, stream rows. |
| ID sources | `src/core/database/id-result-sources.ts` | Explicit-selection and search-result source adapters. |
| DB manager | `src/core/database/manager.ts` | Dexie schema, cursor pages, index pages, facets, imports, invalidation. |
| Result snapshots | `src/utils/result-set.ts` | Descriptor-backed snapshots and bounded ID fallback helpers. |
| Export modal | `src/components/modals/export-data.tsx` | JSON/CSV/HTML and bundle export from either finite arrays or async source streams. |
| Diagnostics | `src/core/database/result-source-diagnostics.ts` and `src/core/perf/metrics.ts` | Source diagnostics and perf counters consumed by app harnesses. |

## Source Descriptors

`ResultSourceDescriptor` is the serializable contract between UI state, exports, diagnostics, and future persistence.

Current descriptor kinds:

- `captures`: all captures for an extension/type in observed-newest order.
- `folder`: one or more bookmark folder IDs, backed by search-document projections and hydrated raw tweet/user rows.
- `explicit_ids`: finite explicit selected IDs.
- `search_ids`: bounded search result IDs.

Descriptors must not contain hydrated tweet/user objects. If a UI path needs all rows, it must stream them through the source or explicitly prove the result set is finite.

## IndexedDB Access Patterns

Capture browsing:

- Count comes from a current count snapshot when possible, then Dexie count fallback.
- Initial and scroll windows use capture ID pages and hydrate only requested IDs.
- Persisted `capture_index_pages` serve cold random-access windows when the source count/revision matches.
- Missing index pages schedule background builds instead of blocking first render.
- Sparse checkpoints support progressive scrolling between persisted index pages.

Folder browsing:

- Folder options and status counts come from DB facet summaries.
- No-query folder selection uses a folder result source for one or more folder IDs.
- Persisted `folder_source_index_pages` serve cold deep folder windows when the descriptor/count/revision matches.
- Search plus folder remains on the lazy worker/search-document path until persisted indexed search exists.

Mutation safety:

- Capture writes, imports, clears, folder backfills, and search-document writes must invalidate matching index pages and source revisions.
- Hooks recreate sources when the database mutation version changes.
- Stale source window completions are ignored by request key.

## Virtualization

`BaseTableView` uses two modes:

- Source browsing mode: total virtual height is estimated from `source.totalCount * estimatedRowHeight`; rendered rows are sliced from the current hydrated source window.
- Finite array mode: offsets are computed for the finite `sortedRecords` array.

Source mode must keep:

- Hydrated rows bounded to the requested source window.
- Rendered rows bounded to the visible virtual range.
- Row-height cache bounded by `ROW_HEIGHT_CACHE_LIMIT`.
- Record lookup IDs bounded to visible/source/search hydrated rows.

Column sorting is disabled for large descriptor-backed source browsing until DB-projected sorting exists. Search and explicit finite result sets can still use bounded client-side sorting.

## Search

Empty-query table open must not load all search documents or build a worker corpus.

Search flow:

- `useSearchDocuments(name, type, false)` starts unloaded.
- `useResultSetController` calls `loadSearchDocuments` only for search intent.
- Worker corpus preparation is gated by non-empty search query.
- Above-threshold full-corpus search is blocked unless the local diagnostic override is set.
- Rapid query changes cancel or stale-ignore obsolete worker work.

The current worker search remains the semantic reference. The persisted inverted index is a separate follow-up workstream.

## Selection

Selection has two modes:

- `all`: all rows matching the current descriptor are selected. `rowSelection` stores bounded exclusion IDs.
- `explicit`: `rowSelection` stores finite selected visible/search IDs.

Do not convert all-mode selection into hydrated selected records. Export all-minus-exceptions by streaming the source and skipping excluded IDs.

## Export

Normal result-set export:

- Uses `streamResultRecords` when source browsing is active.
- Does not call table `loadAll()`.
- Applies all-mode exclusion IDs during streaming.
- Supports cancellation through `AbortController`.

Bundle ZIP export:

- Streams source rows into bounded worker batches.
- Still accumulates final ZIP bytes in browser memory, so high-count bundle memory proof remains a separate playbook item.

Selected export:

- Uses finite selected records only.
- Must remain unavailable or finite if no explicit selected rows exist.

## Diagnostics To Check

The most useful browser-side evidence:

- `window.__scrollmark_result_source_diagnostics_v1`
- `window.__twe_perf_events_v1`

Important metric names:

- `viewer/table-hydrated-records`
- `viewer/table-search-documents`
- `viewer/table-result-ids`
- `viewer/table-record-lookup-ids`
- `viewer/table-selected-records`
- `viewer/table-selection-exceptions`
- `viewer/table-selected-result-count`
- `viewer/db-backed-capture-window`
- `viewer/db-backed-folder-window`
- `viewer/source-window-request-coalesced`
- `viewer/source-window-stale-ignored`
- `search/worker-corpus-candidates`
- `search/readiness-state`
- `export/modal-export-start`
- `export/modal-export-complete`
- `export/modal-export-cancel`
- `db/capture-index-page`
- `db/folder-source-index-page`

## Harness Map

Run focused harnesses from the project root.

| Command | Covers |
| --- | --- |
| `npm run test:db-source-live` | Dexie cursor/count/facet APIs, capture/folder sources, index-page lifecycle, source streaming. |
| `npm run test:result-source-contract` | Descriptor source contracts for explicit/search ID sources. |
| `npm run test:result-set-lookup` | Snapshot descriptors, lookup aliases, bounded fallback snapshots. |
| `npm run test:app-diagnostics-smoke` | Built userscript table open, diagnostics ZIP evidence, no search-doc load on open. |
| `npm run test:small-dataset-workflow` | Small archive table open, folder filter, search, export, mutation invalidation, clear. |
| `npm run test:export-modal-app` | Source streaming export, all-minus-exceptions, explicit selected export, bundle batching/cancel. |
| `npm run test:search-threshold-app` | Above-threshold search degradation without full search-document hydration. |
| `npm run test:search-cancellation-app` | Rapid query cancellation and stale worker suppression. |
| `npm run test:deep-scroll-app` | Deep source-window scheduling, bounded rendered state, long-task budget. |
| `npm run test:folder-source-stress` | Huge-folder and many-folder browser behavior. |
| `npm run test:recovered-db-import` | Recovered Dexie export import compatibility and source/index behavior. |

Standard local gates after code changes:

```bash
npm run lint
npx tsc --noEmit
git diff --check
```

Run `npm run build` before browser harnesses that inject `dist/scrollmark.user.js`.

## Change Checklist

Before changing table/source behavior:

- Identify whether the path is descriptor-backed or finite-array-backed.
- Check whether it can run on empty-query table open.
- Check whether it can trigger full search-document loading.
- Check whether sorting or selection semantics require full result IDs.
- Check whether export should stream from a source descriptor.
- Add or update a harness that proves bounded hydrated rows, result IDs, lookup IDs, and search documents.
- Update `docs/db-backed-table-progress-ledger.md` only after the evidence exists.
