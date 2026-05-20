# Scrollmark Twitter/X Launch Thread Draft

## Media Attachments

Use these compressed screenshots from `docs/screenshots/store/`:

| Label   | File                                          |
| ------- | --------------------------------------------- |
| Media A | `01-scrollmark-visual-research-archive.jpg`   |
| Media B | `02-fullscreen-masonry-bookmark-explorer.jpg` |
| Media C | `03-table-search-author-folder-filters.jpg`   |
| Media D | `04-portable-bundle-viewer.jpg`               |
| Media E | `05-data-and-bundle-export.jpg`               |

## Thread

### 1/n

ATTENTION ALL BOOKMARK ENTHUSIASTS AND LURKERS

If you like bookmarking stuff on Twitter, boy do I have something fun for you.

I spent the last few months slowly building Scrollmark: a Tampermonkey/Violentmonkey userscript that turns your Twitter/X browsing into a local searchable archive.

Attach: Media A, `01-scrollmark-visual-research-archive.jpg`

### 2/n

Here are the links upfront, because I hate when people bury them at the end of the thread:

GitHub:
https://github.com/kmccleary3301/scrollmark

Greasy Fork:
https://greasyfork.org/en/scripts/578937-scrollmark

Install URL:
https://github.com/kmccleary3301/scrollmark/releases/latest/download/scrollmark.user.js

### 3/n

The basic idea is simple:

As you browse Twitter, Scrollmark passively watches the data already flowing through your browser, parses the useful parts, and caches them locally.

Bookmarks, folders, tweets, users, media, likes, threads, retweets, quotes, etc.

No Twitter API key. No backend. No cloud account.

### 4/n

The main thing I wanted was a much better way to deal with bookmarks.

I bookmark a horrifying amount of research, design references, tools, weird lore, papers, models, demos, and “I’ll come back to this later” material.

Twitter’s native bookmark UI is not built for this at all.

### 5/n

So Scrollmark gives you a proper explorer.

There’s a dense table view for metadata/search/export work, and a masonry media view for visually scanning the stuff you saved.

This is especially useful if your bookmarks include papers, diagrams, UI shots, art refs, product screenshots, model outputs, etc.

Attach: Media B, `02-fullscreen-masonry-bookmark-explorer.jpg`

### 6/n

Search was one of the biggest pieces.

It supports natural language search, exact phrases, boosted phrase windows, boolean logic, exclusions, authors, folders, dates, domains, media filters, numeric filters, and raw dotted metadata fields.

Examples:

```text
"full writeup on how"
@sama agent systems
folder:"Design 02" has:media
domain:github.com min_likes:50
```

Attach: Media C, `03-table-search-author-folder-filters.jpg`

### 7/n

The natural-language search is intentionally more like “Google over my bookmarks” than browser find.

Multi-term searches get expanded with phrase boosting, so exact or near-exact phrase hits should rise.

You can also do stricter operator-heavy searches when you know exactly what slice you want.

### 8/n

The performance work was also nontrivial.

I have thousands of bookmarks, and earlier versions would just melt the browser.

Now the explorer uses paged hydration, virtualized table rendering, worker-backed search, stale-query cancellation, and deterministic masonry paging instead of dumping everything into the DOM.

### 9/n

One of my favorite workflows is slicing out a research category, exporting it as a structured bundle, and handing it to GPT-5.5 Pro / other agents to dissect.

Example:

“Here are 300 AI research bookmarks from this folder. Cluster them, extract themes, identify useful papers, surface contradictions, and tell me what to read first.”

### 10/n

This is also why bundles exist.

You can export a portable ZIP bundle of a selected slice of your archive, send it to someone else, and they can import it into Scrollmark’s Bundle Viewer.

It does not touch their real Twitter bookmarks.

It’s just a local browsable/searchable archive.

Attach: Media D, `04-portable-bundle-viewer.jpg`

### 11/n

That means you can share curated research/design/programming collections with friends without doing some gross spreadsheet/export dance.

A bundle can preserve the tweet data, metadata, folder/category context, and searchability.

This makes Twitter bookmarks feel more like a portable research corpus than a private junk drawer.

### 12/n

Exports are a major part of the tool.

You can export selected rows, current search results, JSON/CSV/HTML, canonical bundles, and media.

The media exporter is useful when you want the actual image/video assets for reference boards, datasets, agent analysis, or archival.

Attach: Media E, `05-data-and-bundle-export.jpg`

### 13/n

This technically started as a fork of `prinsss/twitter-web-exporter`:

https://github.com/prinsss/twitter-web-exporter

But at this point it is basically a Ship of Theseus.

I had to rebuild or overhaul almost everything: parsing, storage, search, UI, exports, diagnostics, performance, bundles, reactivity, and the release pipeline.

### 14/n

A surprising amount of the work was just fighting Twitter/X internals.

GraphQL response shapes, bookmark folder weirdness, article posts, browser userscript quirks, CSP issues, Firefox vs Chrome behavior, memory pressure, scroll virtualization, stale search loops, broken media URLs, etc.

Not a “wrap a JSON export in a table” project.

### 15/n

It also has a bunch of diagnostic/debug tooling because Twitter changes things and parsers break.

You can export diagnostic bundles, raw capture traces, search histories, and other repro material.

This was mostly built so I could close the loop with agents while debugging weird capture/search/indexing failures.

### 16/n

There’s support for 10 languages now too.

The core UI text has been pulled into localization files instead of being hard-coded everywhere.

Still not perfect, but it should be much easier to expand and clean up over time.

### 17/n

To be clear: this is local-first tooling.

It does not run a cloud service, does not sync your archive to me, does not need a Twitter API key, and does not mutate your account when viewing imported bundles.

It watches what your browser already loads, parses it, and stores it locally.

### 18/n

I expect there will be bugs because Twitter is Twitter, but I’m pretty happy with where it landed.

The most useful thing if something breaks is a diagnostic bundle + short repro.

Also: if you use it to make/share a good research or design bundle, please send it to me. I want to see what people do with this.

Links again:
https://github.com/kmccleary3301/scrollmark
https://greasyfork.org/en/scripts/578937-scrollmark
