# Scrollmark

Scrollmark is a local-first research archive for X/Twitter. It captures useful data that already flows through the X web app while you browse, stores it locally in your browser, and gives you a fast explorer for search, review, export, and sharing.

It is built for researchers, designers, engineers, writers, and high-signal collectors who use bookmarks as a working memory system and need something more serious than a flat export file.

## What it does

Scrollmark observes X/Twitter web-app API responses in your browser and indexes supported records into local IndexedDB storage.

Core surfaces include:

- Bookmarks and bookmark folders.
- Tweets, tweet details, user tweets, likes, retweeters, quotes, and user details.
- Followers/following surfaces where X exposes them to the page.
- Tweet media, article previews, cards, profile metadata, and useful timeline metadata.
- Imported portable bundles shared by other Scrollmark users.

The script can only capture data that the X web app loads in your browser. It is not an autonomous scraping bot, not a cloud sync service, and not a Twitter/X developer API client.

## Main features

| Feature              | What it gives you                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local capture        | Build a private archive naturally while browsing X.                                                                                                             |
| Search               | Search with natural language, exact phrases, boolean logic, exclusions, author filters, folder filters, dates, domains, media filters, and raw metadata fields. |
| Table explorer       | Inspect dense metadata, select rows, and export exact subsets.                                                                                                  |
| Masonry media view   | Scan visual bookmarks in a fullscreen designer-oriented media layout.                                                                                           |
| Bundle export/import | Share portable research collections as canonical ZIP bundles without mutating anyone's live X account data.                                                     |
| Data export          | Export selected rows or result sets as JSON, CSV, HTML, or bundle ZIP.                                                                                          |
| Media export         | Bulk export tweet images/videos with configurable behavior.                                                                                                     |
| Diagnostics          | Export diagnostic bundles when parser, performance, or browser-runtime issues need investigation.                                                               |

## Search examples

```text
distributed systems design
"full writeup on how"
@sama agent systems
from:alice ("design system"~2 OR reliability)
folder:"Design 02" has:media
domain:github.com min_likes:50
since:2026-03-01 until:2026-03-31 -filter:replies
```

Plain multi-term searches are expanded with boosted adjacent phrase windows. Quoted phrases are treated as phrase constraints. Metadata operators narrow the candidate set before ranking.

## Typical workflow

1. Install Scrollmark with a userscript manager.
2. Open X/Twitter normally.
3. Browse timelines, bookmarks, bookmark folders, profiles, tweet threads, likes, or other supported surfaces.
4. Watch the Scrollmark widget counters increment as supported data is parsed.
5. Open the Bookmarks explorer or another module.
6. Search/filter the archive.
7. Switch between table view and masonry view depending on whether you want metadata inspection or visual scanning.
8. Export selected records, current results, media, diagnostics, or a portable bundle.

## Privacy model

Scrollmark is local-first:

- Captured data is stored in your browser's IndexedDB.
- There is no Scrollmark cloud service.
- There is no account registration for Scrollmark.
- Bundle import is local viewing/searching only; it does not bookmark, like, follow, post, create folders, or otherwise mutate your X account.
- Diagnostic exports are user-triggered files that you choose whether to share.

## Permissions

Scrollmark requests permissions needed for a userscript that runs inside the X/Twitter web app:

- `unsafeWindow` is used to observe web-app runtime/network behavior from the userscript environment.
- `GM_xmlhttpRequest` is used for controlled media/export support where normal page fetch semantics are insufficient.
- `@connect cdn.syndication.twimg.com` supports X/Twitter embed/media handling.

The script matches:

```text
twitter.com
x.com
mobile.x.com
```

## Browser support

Recommended setups:

- Firefox with Violentmonkey or Tampermonkey.
- Chrome with Tampermonkey and user scripts enabled.

Chrome users may need to enable `Allow user scripts` for Tampermonkey in `chrome://extensions`.

## Limitations

- Scrollmark can only parse records that X loads into your browser.
- X can change GraphQL/API response shapes, which may require parser updates.
- Very large media exports are constrained by browser memory, download behavior, and local disk speed.
- Imported bundles are not synced back into your real X bookmarks.
- This is a powerful local archiving tool, not a general-purpose automation or scraping service.

## Links

- GitHub repository: https://github.com/kmccleary3301/scrollmark
- Issues and support: https://github.com/kmccleary3301/scrollmark/issues
- Full README: https://github.com/kmccleary3301/scrollmark#readme
- Bundle format docs: https://github.com/kmccleary3301/scrollmark/blob/main/docs/bundles/canonical-bundle-v1.md
- Direct GitHub release install: https://github.com/kmccleary3301/scrollmark/releases/latest/download/scrollmark.user.js

## Attribution

Scrollmark is maintained by Kyle McCleary. It began as an MIT-licensed fork of `prinsss/twitter-web-exporter`, but has since been rebuilt and overhauled across capture, search, storage, UI, bundle import/export, diagnostics, performance, branding, and release workflows. Original copyright and license notices are preserved.
