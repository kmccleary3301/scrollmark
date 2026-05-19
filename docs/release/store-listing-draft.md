# Scrollmark Store Listing Draft

## Short Description

Local-first X/Twitter research archive, bookmark search, media viewer, and portable bundle export.

## Long Description

Scrollmark helps researchers, designers, programmers, and heavy X/Twitter users build a private local archive from the data that naturally flows through the web app while browsing.

Core capabilities:

- Capture bookmarks, tweets, likes, user details, followers/following surfaces, retweeters, media, search timelines, and other supported X web surfaces while you browse.
- Search captured data locally with natural-language terms, exact phrases, boolean operators, exclusions, folder filters, author filters, and convenient shorthand like `@handle`.
- View large archives in a virtualized table or a masonry media layout.
- Export JSON/CSV/HTML data.
- Export canonical ZIP bundles for sharing research collections.
- Import canonical bundles into an isolated local Bundle Library without changing your real X bookmarks or account state.
- Export diagnostics bundles for debugging parser, capture, database, performance, and browser/runtime issues.

Privacy and storage:

- Data is stored locally in the browser using IndexedDB.
- There is no cloud sync service.
- Bundle import is local viewing/searching only; it does not post, bookmark, follow, like, create folders, or otherwise mutate your X account.
- Diagnostics are user-triggered exports. Performance diagnostics avoid raw search-query text by default.

Permissions:

- `unsafeWindow` is used to observe X web-app network/runtime behavior from the userscript environment.
- `GM_xmlhttpRequest` is used for controlled media/export support where needed.
- Network connect permissions are limited to supported X/Twitter media/CDN endpoints.

Compatibility:

- Firefox: Greasemonkey, Violentmonkey, or equivalent userscript manager depending on current browser support.
- Chrome: Tampermonkey with user scripts enabled.
- The script is designed for `x.com`, `twitter.com`, and `mobile.x.com` web app routes.

Attribution:

Scrollmark is maintained by Kyle McCleary. It began as an MIT-licensed fork of `twitter-web-exporter` by prinsss, but has since been rebuilt and overhauled across the core product surface. Original copyright and license notices are preserved.

## Known Limitations

- The script can only capture data that the web app loads in the browser.
- X can change GraphQL/API response shapes, which may require parser updates.
- Very large exports may require balanced or fastest ZIP compression settings.
- Imported bundles are not synced to, or applied back onto, a real X account.
- Final screenshots should be captured after the final manual QC session confirms the UI.
