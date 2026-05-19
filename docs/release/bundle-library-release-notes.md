# Bundle Library Release Notes Draft

## What This Adds

Scrollmark now supports portable local research bundles:

- Export selected rows or current search result sets as canonical ZIP bundles.
- Import canonical bundle ZIPs into isolated local IndexedDB tables.
- Import legacy JSON/JSONL exports through a compatibility converter.
- Search and inspect imported bundle snapshots from Settings -> Bundle Library.
- Re-export loaded imported subsets as canonical ZIP bundles.
- Preserve live capture tables and real X account state during import.

## Product Boundary

Bundle Library is a local viewing/sharing system. It does not add imported rows to real X bookmarks, does not create folders on X, and does not mutate account state.

## Security Boundary

Imported content is untrusted. The implementation hardens the main text rendering paths and filters media/export URLs to `http` and `https` only. Canonical ZIP import validates paths, manifest shape, record shape, decompressed entry count, per-entry size, and total decompressed size.

## User Workflow

1. Capture/search/filter rows in any tweet/user table.
2. Open `Export Data`.
3. Choose all current results or selected rows.
4. Click `Export Bundle ZIP`.
5. Share the ZIP.
6. Recipient opens Settings -> `Bundle Library`.
7. Recipient imports the ZIP, searches/views it, and optionally re-exports a subset.

## Legacy Workflow

Settings -> `Bundle Library` also accepts `.json` and `.jsonl` files produced by older export flows. These are converted into canonical imported bundle records locally.

## Release Gates

`npm run lint`, `npm run build:e2e`, and `npm run build` pass.
