# Scrollmark Publishing Runbook

This runbook covers the release path for GitHub Releases and userscript marketplaces.

## Artifacts

| Artifact                                       | Audience                          | Notes                                                                                         |
| ---------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `dist/scrollmark.user.js`                      | Direct GitHub install/update URL  | Includes GitHub Release `@downloadURL` and `@updateURL`.                                      |
| `dist/scrollmark.store.user.js`                | Greasy Fork/OpenUserJS submission | Same runtime code, but omits `@downloadURL` and `@updateURL` so the store can manage updates. |
| `dist/twitter-web-exporter-e2e.user.js`        | Local Firefox/e2e QC only         | Uses localhost install/update URL. Do not publish.                                            |
| `dist/twitter-web-exporter-chrome-e2e.user.js` | Local Chrome/e2e QC only          | Uses localhost install/update URL. Do not publish.                                            |

## Versioning

1. Update `package.json` version.
2. Run `npm install --package-lock-only` if only the version changed.
3. Commit the version bump.
4. Tag the exact commit with `vX.Y.Z`.
5. Push `main`, then push the tag.

The release workflow refuses to publish if the tag does not match `package.json`.

## Local preflight

```bash
npm ci
npm run lint
npm run build:all
npm run check:metadata
```

Expected production outputs:

```text
dist/scrollmark.user.js
dist/scrollmark.store.user.js
dist/twitter-web-exporter-e2e.user.js
dist/twitter-web-exporter-chrome-e2e.user.js
```

## GitHub Release

GitHub release publishing is automated by `.github/workflows/release.yml` on tags matching `v*.*.*`.

Manual equivalent:

```bash
VERSION="$(node -p "require('./package.json').version")"
npm run build:all
npm run check:metadata
mkdir -p release-artifacts
cp dist/scrollmark.user.js release-artifacts/scrollmark.user.js
cp dist/scrollmark.store.user.js release-artifacts/scrollmark.store.user.js
(cd release-artifacts && sha256sum *.user.js > SHA256SUMS.txt)
gh release create "v${VERSION}" release-artifacts/* \
  --repo kmccleary3301/scrollmark \
  --title "Scrollmark v${VERSION}"
```

Canonical direct install URL:

```text
https://github.com/kmccleary3301/scrollmark/releases/latest/download/scrollmark.user.js
```

## Greasy Fork

Use `dist/scrollmark.store.user.js`.

Recommended flow:

1. Create a new script on Greasy Fork.
2. Paste/upload `dist/scrollmark.store.user.js`.
3. Use the listing copy from `docs/release/store-listing-draft.md`.
4. Add current screenshots from `docs/screenshots/`.
5. Confirm the store does not reject external `@require` URLs.
6. If the store accepts GitHub sync for this script, point it at the store artifact source path, not the direct-install release artifact.

Do not submit local e2e artifacts.

## OpenUserJS

Use `dist/scrollmark.store.user.js`.

Recommended flow:

1. Create a new script on OpenUserJS.
2. Paste/upload `dist/scrollmark.store.user.js`.
3. Use the listing copy from `docs/release/store-listing-draft.md`.
4. Add repository, issue tracker, and screenshots.
5. Configure GitHub sync only if it preserves the store-safe artifact semantics.

Do not submit local e2e artifacts.

## Post-release checks

- Install from the GitHub Release URL in Firefox and Chrome.
- Verify the widget header reads `Scrollmark` and `By Kyle McCleary`.
- Verify the update URL in the manager points at the latest release artifact for direct installs.
- Verify the store-hosted install is managed by the store and does not point back to localhost or e2e paths.
- Open Bookmarks, search, Bundle Viewer, Export Data, and Export Media.
- Export a small canonical bundle and re-import it into Bundle Viewer.
