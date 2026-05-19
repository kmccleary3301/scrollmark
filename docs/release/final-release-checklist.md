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
- [ ] Manual browser QC completed against real exports.
- [ ] Script store README/screenshots updated.
- [ ] Final README screenshots refreshed after manual QC if current screenshots no longer represent the release UI.

## Manual QC Fixtures

- `e2e/fixtures/bundles/legacy-export-sample.json`
- `e2e/fixtures/bundles/malicious-legacy-export-sample.json`

## Stop Conditions

- Do not publish stable if imported HTML/script executes.
- Do not publish stable if importing/deleting a bundle changes live capture counters.
- Do not publish stable if canonical ZIP export cannot be re-imported.
- Do not publish stable if lint remains intentionally required by CI.
