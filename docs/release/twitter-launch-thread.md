# Scrollmark Twitter/X Launch Thread Draft

Every tweet below is intended to stay under 280 characters. Media attachment notes are outside the tweet text.

## Media Attachments

Use these compressed screenshots from `docs/screenshots/store/`:

| Label | File |
| --- | --- |
| Media A | `01-scrollmark-visual-research-archive.jpg` |
| Media B | `02-fullscreen-masonry-bookmark-explorer.jpg` |
| Media C | `03-table-search-author-folder-filters.jpg` |
| Media D | `04-portable-bundle-viewer.jpg` |
| Media E | `05-data-and-bundle-export.jpg` |

## Thread

### 1/n

ATTENTION ALL BOOKMARK ENTHUSIASTS AND LURKERS

If you like bookmarking stuff on Twitter, boy do I have something fun for you.

I spent months building Scrollmark: a userscript that turns Twitter/X browsing into a local searchable archive.

Attach: Media A, `01-scrollmark-visual-research-archive.jpg`

### 2/n

Links upfront because burying them at the bottom is annoying:

GitHub:
https://github.com/kmccleary3301/scrollmark

Greasy Fork:
https://greasyfork.org/en/scripts/578937-scrollmark

Install:
https://github.com/kmccleary3301/scrollmark/releases/latest/download/scrollmark.user.js

### 3/n

Basic idea:

Twitter already sends a lot of structured data through your browser as you browse.

Scrollmark watches that stream, parses what it can, and stores it locally.

No Twitter API key. No backend. No cloud account.

### 4/n

It can pick up bookmarks, bookmark folders, tweets, users, likes, media, threads, quote/retweet surfaces, and other stuff that flows through the web app.

The constraint is simple: if Twitter doesn't load it in your browser, Scrollmark can't parse it.

### 5/n

My own bookmarks were the main motivation.

I bookmark research, design refs, papers, model releases, demos, tools, weird arguments, UI screenshots, and random “this will matter later” posts.

Twitter's bookmark UI is not built for this.

### 6/n

So the core view is a real bookmark explorer.

Dense table for search/metadata/export work.

Masonry view for visual scanning.

The masonry one is especially good for research/design folders full of diagrams, screenshots, papers, and UI refs.

Attach: Media B, `02-fullscreen-masonry-bookmark-explorer.jpg`

### 7/n

Search was a big part of the work.

It supports unstructured search, exact phrases, phrase boosting, boolean logic, exclusions, folders, authors, dates, domains, media filters, numeric filters, and raw metadata fields.

Attach: Media C, `03-table-search-author-folder-filters.jpg`

### 8/n

Example searches:

```text
"full writeup on how"
@sama agent systems
folder:"Design 02" has:media
domain:github.com min_likes:50
```

Goal was closer to “Google over my bookmarks” than browser find.

### 9/n

Unstructured queries expand into term matches + boosted phrase windows.

Then you can get more surgical with operators when you know the slice you want.

Not ParadeDB-level magic, but now fast enough and expressive enough to be useful.

### 10/n

Performance was painful.

Early versions would happily nuke the browser if I opened a big bookmark table or typed a long query.

Now it uses paged IndexedDB reads, virtualized rows, worker-backed search, stale query cancellation, and deterministic masonry paging.

### 11/n

My favorite use case is mining a narrow research slice.

Filter to a folder/category, export a bundle, and pass it to GPT-5.5 Pro or another agent to pull apart.

“Here are 300 AI research bookmarks. Cluster them and tell me what to read first.”

### 12/n

This is why bundle export/import exists.

You can package a slice of your archive as a portable ZIP, send it to someone else, and they can open it in the same explorer UI.

It does not touch their real Twitter bookmarks.

Attach: Media D, `04-portable-bundle-viewer.jpg`

### 13/n

I think bundles are one of the more useful parts.

Twitter bookmarks contain a lot of latent social/research value, but they're trapped in private junk drawers.

Bundles make “here is my RL infra reading set” a usable object.

### 14/n

Exports are built in.

Selected rows, current results, JSON/CSV/HTML, portable bundles, media URLs, and bulk media.

Useful for agent analysis, reference boards, archival, or just getting raw assets out of Twitter.

Attach: Media E, `05-data-and-bundle-export.jpg`

### 15/n

This technically started as a fork of this project:

https://github.com/prinsss/twitter-web-exporter

But it is very much Ship of Theseus now.

The parser, DB, search, UI, exports, diagnostics, performance path, bundles, and release flow were all rebuilt/heavily changed.

### 16/n

A lot of the work was just fighting Twitter and browser weirdness.

GraphQL response shapes, bookmark folder behavior, article posts, CSP, userscript injection, Firefox vs Chrome quirks, stale search loops, scroll virtualization, media URL edge cases, memory overhead, etc.

### 17/n

There is also a lot of diagnostic machinery now.

Raw capture bundles, search history export, parser diagnostics, perf counters, safe mode, repair mode, etc.

Mostly so I could hand agents enough evidence to debug things without manually reproducing every failure forever.

### 18/n

It has 10-language UI support now too.

Not saying the translations are sacred literature, but the UI text is centralized/localized instead of hard-coded all over the app.

That was one of the late cleanup passes before making it public.

### 19/n

Important clarification:

This is local-first tooling.

It does not run a cloud service, sync your archive to me, need a Twitter API key, or mutate your account when viewing imported bundles.

It watches what your browser already loads and stores parsed data locally.

### 20/n

Anyway, I expect bugs because Twitter is Twitter, but it is useful enough that I want other bookmark freaks to try it.

If something breaks, the most useful thing is a diagnostic bundle + short repro.

And if you make a good research/design bundle, send it to me.

### 21/n

Links again:

GitHub:
https://github.com/kmccleary3301/scrollmark

Greasy Fork:
https://greasyfork.org/en/scripts/578937-scrollmark
