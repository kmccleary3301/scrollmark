# Canonical Bundle v1

Canonical bundles are portable ZIP files for sharing exported Scrollmark records without mutating a recipient's X account or live capture tables.

## ZIP Layout

- `manifest.json`: bundle identity, producer metadata, privacy summary, counts, and file manifest.
- `records/records.jsonl`: one `BundleRecordEnvelope` JSON object per line.
- `media/media-urls.txt`: optional newline-delimited original media URLs for external download tools.

## Import Behavior

Imported bundles are stored in isolated IndexedDB tables:

- `imported_bundles`
- `imported_bundle_collections`
- `imported_bundle_items`
- `imported_entity_snapshots`
- `imported_bundle_import_reports`

Import does not write to live `tweets`, `users`, `captures`, or `social_edges` tables.

## Security Rules

- ZIP paths are normalized and reject absolute/parent traversal paths.
- ZIP decompression has entry count, per-entry byte, and total byte limits.
- Manifest and record envelopes are validated before persistence.
- Imported/captured text is rendered as escaped text, with only sanitized `http`/`https` entity links regenerated.
- HTML export uses text nodes for tweet/user text.

## Current UI Surfaces

- Export Data modal: `Export Bundle ZIP` creates canonical share ZIPs from selected rows or the pinned result set.
- Settings: `Bundle Library` imports canonical ZIPs, lists imported bundles, searches snapshots, inspects raw records, and deletes imported bundles.

## Deliberate v1 Boundary

Bundle import is local-library import only. It does not create, modify, or delete X bookmarks/folders.
