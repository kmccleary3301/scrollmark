# DB-Backed Table Architecture Notes

These notes resolve design-only checklist items from `db-backed-table-scalability-playbook.md`.

## DB Invariants

- Capture IDs are unique per extension/type membership row. Capture order is defined by `(created_at, id)` with `id` as the deterministic tie-breaker.
- Capture cursor stability depends on immutable capture IDs and append-like capture writes. Mutations that clear, reimport, or rewrite captures must invalidate active source keys.
- Tweet/user hydration is intentionally separate from source membership. Result sources fetch capture or search-document IDs first, then hydrate only requested visible IDs.
- Search documents are lightweight projections for facets, folder filters, and search corpus construction. They are not the source of truth for tweet/user payloads.
- Search document folder metadata is trusted in this order: API folder name, stable ID-only fallback, no folder metadata.
- Folder name backfills may change facet labels, but must not change folder IDs or source membership.
- Offset reads are acceptable only as a temporary cold random-access fallback. Sequential and progressive browsing should prefer cursor/keyset reads from source-local or persisted checkpoints.
- Result descriptors must remain serializable and must not contain hydrated records.

## Sort-Key Strategy

DB-backed now:

- Default observed/newest order for captures: capture `created_at` plus capture `id`.
- Default observed/newest order for folder sources: search document `observed_at_ms` plus document `id`.

DB-backed with projected columns:

- Tweet created time: projected `created_at_ms`.
- Engagement counts: projected numeric fields from `numeric_json`.
- Author/screen name: projected text columns normalized for case-insensitive ordering.
- Folder label: projected trusted label plus folder ID fallback.

Client-side only until projected:

- Columns whose values are computed from nested hydrated tweet/user objects.
- Columns that use custom `exportValue`/render-only logic without a stable DB projection.
- Search rank order from the current worker result path.

Rule:

- Empty-query browsing must not sort unbounded result arrays client-side.
- Unsupported large-source sort columns should show an explicit transitional state or operate only on bounded search/selection result sets.

## Table State Shape

Target state ownership:

- `sourceDescriptor`: serializable descriptor for captures, one folder, search, explicit selection, bundle, or future merged sources.
- `sourceKey`: stable serialized descriptor plus schema/version inputs.
- `visibleRange`: requested start/end indexes, overscan range, source window start, and current row IDs.
- `visibleRows`: hydrated records for the current rendered window only.
- `sourceMetadata`: total count, loading state, last fetch duration, cache pages, cached rows, stale request token.
- `selectionDescriptor`: either all rows matching `sourceDescriptor`, or a finite explicit ID list. All-mode does not own hydrated records.
- `sortDescriptor`: DB-backed sort key or a bounded client-side sort marker.
- `searchState`: idle/preparing/querying/blocked/failed plus query text and engine.
- `folderState`: facet summary, selected folder IDs, source-backed status for one-or-more no-query folders, and fallback status for search-plus-folder.
- `exportState`: active export descriptor, progress, cancellation token, and last error.
- `alternateViewState`: active view and source-backed capability/guard state.

State that must not be authoritative for unbounded sources:

- Full `records` arrays.
- Full `sortedRecords` arrays.
- Full `recordById` maps.
- Full current-result ID arrays.
- Full selected hydrated records in all-mode.

Allowed bounded arrays:

- Visible source window rows.
- Bounded page cache rows.
- Explicit finite selected ID lists.
- Lazy worker search results capped by query limits.
- Small dataset compatibility paths where diagnostics prove the result set is bounded.

## Folder Label Precedence

- API-provided folder name wins when `folder_name_source === "api"` and the name is non-empty.
- If only a folder ID is available, the UI uses `Folder ${folderId}` as a stable fallback.
- If no folder ID is available, the row belongs to the `none` status bucket and is not shown as a selectable folder.
- Backfilled API names may replace fallback labels, but the folder ID remains the stable selection value.

## Alternate View Audit

Current alternate views:

- `TweetMediaMasonry` receives a `records` array and flattens all media items from that array.
- In source-backed table mode, the parent now passes only the visible/source window for the extra modal context, but the masonry view is still not a true media result source.
- The current smoke harness exercises masonry and shows it does not blank on 5k synthetic data, but it is not accepted as DB-backed for massive datasets.

Required before release:

- Add a media result source or explicitly disable/guard masonry for very large result descriptors.
- Preserve small dataset masonry behavior once the media source is introduced.

## Persisted Search Index Design

The current worker search remains the semantic reference. IndexedDB cannot replace phrase/slop/boolean full-text behavior with simple store queries.

Candidate tables:

- `search_index_documents`: document ID, source document ID, entity type, updated/indexed timestamps, language, folder ID, route type, recency score inputs.
- `search_index_terms`: term, normalized term, document frequency, last indexed version.
- `search_index_postings`: term ID, document ID, field mask, term frequency, first position, positions blob for phrase/slop support.
- `search_index_metadata`: schema version, analyzer version, build status, last successful backfill cursor, invalidation counters.

Index MVP decision:

- MVP is a follow-up workstream, not part of the first table rewrite.
- MVP must preserve current semantics before replacing worker search by default.
- A diagnostic or opt-in indexed-search mode may ship earlier, but the UI must label semantic differences clearly.
- Phrase/slop support requires positional postings. Without positions, indexed search is not an acceptable silent replacement.

Backfill rules:

- The app must open and browse before the index is fully built.
- Backfill should run incrementally and yield between batches.
- Writes/imports invalidate only affected documents where possible.
- Search readiness must distinguish `idle`, `preparing legacy corpus`, `indexed-search building`, `ready`, `blocked`, and `failed`.

## Release Checklist

- Build production userscript and verify metadata.
- Run synthetic 10k, 50k, and 100k table-open/deep-scroll smoke.
- Verify no full search-document load on empty table open.
- Verify single huge folder source browsing.
- Verify multi-folder source-backed browsing and deep-jump fallback behavior are explicit.
- Verify normal JSON/CSV/HTML export streams from the active source.
- Verify bundle ZIP behavior and document its transitional memory limits.
- Verify search under threshold, over threshold blocked warning, and local override.
- Verify clear/reset and reindexing still update counts.
- Verify Violentmonkey local install and widget injection.
- Verify browser matrix selected for release.

## Rollback Plan

- Keep the `1.0.2` injection/bundling hotfix independently releasable from table architecture changes.
- If DB-backed browsing fails before release, ship only the injection/bundling hotfix and keep the table rewrite local.
- If a severe table issue appears after release, publish a patch from the last known-good source-backed revision or explicitly revert the cleanup commit that removed the legacy table branch. There is no runtime legacy table flag after the 11.4 cleanup.
- DB version upgrades add indexes and should remain forward-compatible; do not require destructive DB rollback.
- If a new index/backfill path fails, degrade affected features and keep capture browsing available.
- Diagnostics should include result descriptors, source counts, cache/window state, and blocked/degraded feature states to support remote triage.

## Resolved Playbook Decisions

- First high-water synthetic target: 100k rows for the first rewrite release gate. 250k remains a stress target before broader release confidence. 1m is an architectural torture target, not a release blocker.
- Persisted inverted index timing: follow-up workstream after DB-backed browsing/export is stable. The first rewrite must keep lazy worker search for below-threshold corpora and explicit blocked/degraded states above threshold.
- First-release DB-backed sorts: default observed/newest ordering for captures and folder sources only. Additional sortable columns require projected fields before they can be enabled on unbounded sources.
- Media masonry first pass: guard or degrade for massive datasets until a source-backed media view exists. Do not let masonry silently flatten every matching tweet.
- Multi-folder folder browsing: no-query bookmark folder selections use a merged DB-backed folder source for one or more folder IDs. Search plus folder continues to use the lazy worker/search-document path until persisted indexed search or projected query support exists.
