# Unified Final QC Session Runbook

Manual QC is intentionally backloaded until implementation and automated validation are complete.

## Preconditions

Do not start user manual QC until all are true:

- Search worker path is enabled and diagnostics show it is available.
- Bundle ZIP export worker path is enabled and diagnostics show it is available.
- Search, viewer, and export performance metrics appear in diagnostics bundles.
- Bundle import/export automated checks pass against representative fixtures.
- Chrome and Firefox install endpoints are verified.
- Known release blockers are resolved or explicitly documented.

## Firefox Pass

1. Install or update the Firefox userscript build.
2. Hard reload `https://x.com/home`.
3. Confirm the widget appears.
4. Confirm the cat icon is still present.
5. Confirm the product header and attribution are correct if rebrand is active.
6. Browse home timeline for 2 to 3 minutes.
7. Browse bookmarks and at least one bookmark folder.
8. Open Bookmarks viewer.
9. Type a long multi-term query quickly.
10. Confirm typing does not freeze.
11. Confirm result quality with an exact phrase from a known bookmark.
12. Switch table/masonry views and scroll deeply.
13. Export JSON results.
14. Export Bundle ZIP with balanced compression.
15. Cancel one Bundle ZIP export before completion.
16. Import a Bundle ZIP.
17. Search inside imported bundle.
18. Export diagnostics bundle.

## Chrome Pass

Repeat the critical subset:

1. Install or update the Chrome/Tampermonkey build.
2. Confirm widget appears after hard reload.
3. Browse home timeline and bookmarks.
4. Open Bookmarks viewer.
5. Run long search query.
6. Export Bundle ZIP.
7. Import Bundle ZIP.
8. Export diagnostics bundle.

## Failure Artifacts

If any failure occurs, collect:

- diagnostics bundle,
- console errors,
- browser name/version,
- userscript manager/version,
- exact route,
- exact action that triggered failure,
- whether safe mode was on/off,
- whether Chrome or Firefox.
