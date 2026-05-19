# Bundle Library QC Checklist

## Build Gates

- `npm run build:e2e`
- `npm run build`

## Canonical Export

- Open any tweet/user table.
- Search/filter to a non-empty result set.
- Open `Export Data`.
- Export `Export Bundle ZIP` with `All current results`.
- Repeat with explicit selected rows.
- Confirm ZIP includes `manifest.json` and `records/records.jsonl`.
- If rows contain media, confirm `media/media-urls.txt` exists.

## Canonical Import

- Open Settings -> `Bundle Library`.
- Import the canonical ZIP.
- Confirm bundle appears in the list with `ready` status.
- Click `View`.
- Search for an exact phrase from an imported row.
- Filter by `tweets` and `users`.
- Open at least one details row and confirm text/media preview plus raw JSON render.
- Click `Export Loaded Subset` and import that output again.

## Legacy Import

- Import `e2e/fixtures/bundles/legacy-export-sample.json`.
- Confirm two rows import.
- Search for `Exact phrase boosting sample`.
- Confirm media preview is visible.

## Malicious Import

- Import `e2e/fixtures/bundles/malicious-legacy-export-sample.json`.
- Confirm no script executes.
- Confirm text is displayed as text, not active HTML.
- Confirm unsafe `javascript:` media URLs do not become clickable privileged UI actions.

## Isolation

- Confirm imported bundle counts do not change widget capture counters.
- Delete an imported bundle.
- Confirm live captures remain intact.

## Non-Goals

- Do not test or expect any mutation of real X bookmarks/folders.
- Do not import DMs through the default shared bundle path.
