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

I spent the last several months passively building a userscript that caches the useful stuff flowing through my browser on Twitter, then gives me a real interface for searching, organizing, exporting, and sharing it.

Attach: Media A, `01-scrollmark-visual-research-archive.jpg`

### 2/n

It's called Scrollmark.

Links upfront because I hate when people bury them at the bottom:

GitHub:
https://github.com/kmccleary3301/scrollmark

Greasy Fork:
https://greasyfork.org/en/scripts/578937-scrollmark

Install:
https://github.com/kmccleary3301/scrollmark/releases/latest/download/scrollmark.user.js

### 3/n

Basic idea:

Twitter already sends a ton of structured data through your browser as you browse.

Scrollmark watches that stream, parses what it can, and stores it locally.

Bookmarks, bookmark folders, tweets, users, likes, media, threads, quote/retweet surfaces, etc.

No Twitter API key. No backend. No account.

### 4/n

The initial motivation was just that my bookmarks are completely out of control.

I bookmark research, design refs, papers, model releases, demos, tools, weird arguments, UI screenshots, random “this will matter later” posts, etc.

Twitter's bookmark UI is not remotely enough for this.

### 5/n

So the main view is a real bookmark explorer.

There's a dense table for search/metadata/export work, and a masonry view for visual scanning.

The masonry view is especially nice for research/design folders, where half the value is in diagrams, screenshots, papers, UI refs, and visual artifacts.

Attach: Media B, `02-fullscreen-masonry-bookmark-explorer.jpg`

### 6/n

Search was a big part of the work.

You can do normal unstructured searches, exact phrases, phrase boosting, boolean logic, exclusions, folders, authors, dates, domains, media filters, numeric filters, and raw metadata fields.

Examples:

```text
"full writeup on how"
@sama agent systems
folder:"Design 02" has:media
domain:github.com min_likes:50
```

Attach: Media C, `03-table-search-author-folder-filters.jpg`

### 7/n

The goal was closer to “Google over my bookmarks” than browser find.

Unstructured queries expand into term matches + boosted phrase windows.

Then you can get more surgical with operators when you know the slice you want.

It's not ParadeDB-level magic, but it's now fast enough and expressive enough to be genuinely useful.

### 8/n

Performance was painful.

Early versions would happily nuke the browser if I opened a big bookmark table or typed a long query.

Now it uses paged IndexedDB reads, virtualized rows, worker-backed search, stale query cancellation, and deterministic masonry paging.

The boring stuff, but it matters.

### 9/n

My favorite use case is mining a narrow research slice.

I'll filter down to a folder/category, export a bundle, and pass it to GPT-5.5 Pro or another agent to pull apart.

“Here are 300 AI research bookmarks. Cluster them, find the useful papers, extract themes, surface contradictions, tell me what to read first.”

Very good workflow.

### 10/n

This is why bundle export/import exists.

You can package a slice of your archive as a portable ZIP, send it to someone else, and they can open it in the same explorer UI.

It does not touch their real Twitter bookmarks.

It's just a local, searchable, browsable research bundle.

Attach: Media D, `04-portable-bundle-viewer.jpg`

### 11/n

I think this is one of the more underrated parts.

Twitter bookmarks contain a lot of latent social/research value, but they're trapped in private junk drawers.

Bundles make it plausible to share “here is my current RL infra reading set” or “here are 500 design refs I actually like” in a usable form.

### 12/n

Exports are also built in.

Selected rows, current results, JSON/CSV/HTML, portable bundles, media URLs, and bulk media.

The media export is useful if you want to hand a folder to an agent, build a reference board, preserve a research/design set, or just get the raw assets out of Twitter.

Attach: Media E, `05-data-and-bundle-export.jpg`

### 13/n

This technically started as a fork of this project:

https://github.com/prinsss/twitter-web-exporter

But it is very much Ship of Theseus at this point.

I had to rebuild or heavily overhaul the parser, DB layer, search, UI, exports, media handling, diagnostics, performance path, bundle system, and release flow.

### 14/n

A lot of the work was just fighting Twitter and browser weirdness.

GraphQL response shapes, bookmark folder behavior, article posts, CSP, userscript injection, Firefox vs Chrome quirks, stale search loops, scroll virtualization, media URL edge cases, memory overhead, etc.

All the dumb invisible stuff.

### 15/n

There is also a lot of diagnostic machinery now.

Raw capture bundles, search history export, parser diagnostics, perf counters, safe mode, repair mode, etc.

Mostly because Twitter changes constantly and I needed a way to hand agents enough evidence to debug things without me manually reproducing every failure forever.

### 16/n

Also: it has 10-language UI support now.

Not saying the translations are sacred literature, but the UI text is at least centralized/localized instead of being hard-coded all over the app.

That was one of the late cleanup passes before trying to make it public.

### 17/n

Important clarification:

This is local-first tooling.

It does not run a cloud service, does not sync your archive to me, does not need a Twitter API key, and does not mutate your account when viewing imported bundles.

It watches what your browser already loads, parses it, and stores it locally.

### 18/n

Anyway, I expect bugs because Twitter is Twitter, but it is now useful enough that I want other bookmark freaks to try it.

If something breaks, the most useful thing is a diagnostic bundle + short repro.

And if you use it to make a good research/design bundle, send it to me. I want to see what people do with this.

GitHub:
https://github.com/kmccleary3301/scrollmark

Greasy Fork:
https://greasyfork.org/en/scripts/578937-scrollmark
