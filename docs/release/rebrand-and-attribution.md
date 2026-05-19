# Rebrand And Attribution

## Public Product Name

The release-facing product name is `Scrollmark`.

Widget header:

```text
Scrollmark
By Kyle McCleary
```

## Icon Policy

The existing userscript icon is retained for this release. Do not replace the cat/icon asset unless the product owner explicitly requests it later.

## Compatibility Policy

The local dev URL path, generated local e2e filenames, database discovery strings, and legacy bundle producer identifier may remain `twitter-web-exporter` for compatibility in this release. The release-facing package identity is `scrollmark` at version 1.0.0.

Rationale:

- Avoid unnecessary IndexedDB or update-channel migration risk during the final hardening phase.
- Preserve compatibility with existing exports, diagnostics, and local install endpoints.
- Keep original fork lineage easy to audit.

## Attribution Policy

Scrollmark is a heavily overhauled fork of `prinsss/twitter-web-exporter`.

Release materials must preserve:

- MIT license.
- Original project attribution.
- A clear note that the current overhaul/release is by Kyle McCleary.

Suggested release copy:

```text
Scrollmark is a local-first X/Twitter research archive and export userscript by Kyle McCleary,
built from a substantially overhauled MIT-licensed fork of Twitter Web Exporter by prinsss.
```

## Store Metadata Direction

Short description:

```text
Local-first X/Twitter research archive, bookmark search, media viewer, and portable bundle export.
```

Long description should emphasize:

- local IndexedDB storage,
- bookmark/tweet/user capture while browsing,
- advanced search with phrases/operators,
- masonry media viewing,
- canonical ZIP bundle export/import,
- diagnostics and raw capture tooling,
- no cloud service,
- no mutation of imported bundles into a real X account.

## Deferred Renames

Do not rename these before first stable release unless explicitly approved:

- `package.json` package name,
- IndexedDB database name,
- raw spool database name,
- local development endpoint path,
- canonical bundle producer app id.
