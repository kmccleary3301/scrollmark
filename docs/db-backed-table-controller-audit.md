# DB-Backed Table Controller Audit

This audit closes the controller-specific cleanup gate from `docs/db-backed-table-scalability-playbook.md`. It focuses on whether the current main table can still turn a descriptor-backed result set into full UI-owned arrays.

## Scope

In scope:

- `src/components/table/table-view.tsx`
- `src/components/table/base.tsx`
- `src/components/table/use-result-set-controller.ts`
- `src/components/modals/export-data.tsx`
- `src/components/modals/export-media.tsx`
- `src/utils/result-set.ts`

Out of scope for this specific checklist item:

- Imported bundle viewer pagination in `src/components/bundles/bundle-viewer-panel.tsx`. It still uses `BaseTableView` as a finite paged bundle explorer and may call `loadAll()` for its own export modal. That is not the primary source-backed bookmark/tweet/user table path, and it remains a future bundle-source cleanup target rather than evidence against the main table rewrite.
- Persisted inverted search index implementation. Search remains the lazy worker/search-document path with threshold/degradation guards.

## Main Table Source Path

`TableView` now always renders `SourceBackedTableView`. There is no runtime branch back to the old table hook.

The main table passes source-backed state into `BaseTableView`:

- `sourceMode`
- `sourceModeFiltersActive`
- `sourceWindowStartIndex`
- `resultSourceDescriptor`
- `onSourceWindowChange`
- `streamSourceRows`
- `streamMediaRows`
- `hydrateRecordsByIds`

The main table does not pass `loadMore` or `loadAll` into `BaseTableView`. Those props remain only because `BaseTableView` is also used by the imported bundle viewer.

## Controller Array Audit

| Pattern | Current Status | Bound |
| --- | --- | --- |
| `records` prop | Bounded source window from `useDbBackedCapturedRecords` or `useDbBackedFolderRecords` for the main table. | Initial source window plus scroll window, proven by diagnostics at 10k/100k. |
| `recordById` | Built from current `records` plus bounded hydrated search/folder records. | Measured by `viewer/table-record-lookup-ids`; 100k export-memory proof stayed at 160 lookup IDs. |
| `sortedRecords` | Still exists for finite modes. In descriptor browsing with no query/sort, it is not the virtualizer authority; source sorting is disabled when the source has more rows than the window. | Current source window or bounded search/folder result path, not full descriptor count. |
| `currentResultIds` | Derived from `sortedRecords`, so it is bounded in source browsing. Descriptor-backed snapshots omit these IDs. | 100k export-memory proof stayed at 80 result IDs. |
| `selectedRecords` | Empty for all-mode. Explicit mode filters only the bounded current result array, while source-backed selected export uses the selected ID list and explicit-selection source adapter. | All-mode selection stores bounded exclusion IDs; explicit selected export streams from selected IDs. |
| `resultSetSnapshot.ids` | Empty for descriptor-backed all-results snapshots. Non-source fallback IDs are capped by `RESULT_SET_SNAPSHOT_ID_LIMIT`. | 0 IDs for descriptor-backed all-results; 5000 max fallback. |
| `workerCorpusRows` | Built only after search intent. Empty-query table open does not construct a worker corpus. | No-eager-search browser proof recorded worker corpus candidates at 0. |
| `searchHydratedRecords` | Bounded by `MAX_FOLDER_HYDRATE_RECORDS`; query hydration capped by `MAX_QUERY_HYDRATE_RECORDS`. | 6000 folder cap, 1200 query cap. |
| `rowHeightsRef` | Bounded measurement cache. | `ROW_HEIGHT_CACHE_LIMIT` is 2500. |
| `virtualOffsets` | Not allocated for descriptor source browsing. Source browsing uses estimated total height. | Finite-array mode only. |

## Export And Modal Contracts

For descriptor-backed source browsing, `BaseTableView` opens `ExportDataModal` with:

- `resultRecords={visibleRecords}`
- `resultCount={totalRows}`
- `streamResultRecords={streamSourceRows}`
- `selectedRecords={selectedRecords}`
- `selectionExcludedRecordIds={selectionExcludedRecordIds}`
- `resultSetSnapshot={resultSetSnapshot}`

This preserves existing modal contracts while moving all-results work to the source stream. Source-backed explicit selected export uses a selected-record stream built from the explicit-selection source adapter. Source-backed search result export uses a search result source adapter wrapping the current worker result ID list. The modal can still use finite arrays for finite non-source result sets.

For source-backed media export, `TableView` passes the DB-indexed media result stream into `ExportMediaModal`. The modal scans media-bearing source rows into media URL rows asynchronously and no longer depends on the visible table row array for large bookmark media export.

## Evidence Commands

Current code-search evidence:

```bash
rg 'twe_table_source_mode_v1|table-rollout-mode|test:table-rollout-flag|table_rollout_flag|LegacyTableView|useCapturedRecords\(' src e2e package.json --glob '!e2e/perf/out/**'
rg -n 'loadAll=|loadAll\?|loadAll\(|loadMore=' src/components/table src/components/bundles
rg -n 'sortedRecords|selectedRecords|currentResultIds|recordById|workerCorpusRows|virtualOffsets|ROW_HEIGHT_CACHE_LIMIT' src/components/table src/utils/result-set.ts
```

Expected interpretation:

- The rollout/legacy hook search has no live source, harness, or package hits.
- `loadAll`/`loadMore` hits in `BaseTableView` are retained for the imported bundle viewer; the main `TableView` call sites do not pass them.
- Remaining controller arrays are either source-window bounded, explicit finite arrays, lazy search arrays, or capped diagnostic/fallback structures.

Current runtime evidence:

- `npm run test:app-diagnostics-smoke`
- `npm run test:export-modal-app`
- `npm run test:deep-scroll-app`
- `npm run test:variable-height-table`
- `npm run test:small-dataset-workflow`
- `npm run test:export-memory-app`
- `npm run test:recovered-db-browser`

The strongest high-count proofs are:

- `e2e/perf/out/deep-scroll-app-100k-index-pages.json`: 100k complete-mode capture browsing with bounded hydrated rows, result IDs, lookup IDs, visible rows, and no table long task above 250ms.
- `e2e/perf/out/export-memory-app-100k.json`: 100k descriptor-backed export start/cancel with 80 result IDs, 160 lookup IDs, 80 hydrated rows, 0 search documents, and bounded source diagnostics.
- `e2e/perf/out/recovered-db-browser-round019.json`: recovered v6 browser import and folder selection with bounded table state.

## Remaining Work Not Closed By This Audit

- Search plus folder still uses the lazy worker/search-document path until persisted indexed search or projected query support exists.
- Persisted inverted search index implementation remains open; the current search result source adapter wraps the bounded lazy worker result IDs.
- Imported bundle viewer still has finite paged `loadAll()` behavior and should eventually get a bundle result source if massive bundle exploration becomes a release gate.
- Final whole-project dead-code audit remains open until the remaining partial playbook items are resolved.
