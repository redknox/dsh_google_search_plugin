# Changelog

All notable changes to this project are recorded here.

## 0.1.1 (2026-08-27)

### Fixed

- **Scoped package name in the bundle patch**: the 0.1.0 tarball's
  `cordis.patch.yml` referenced the unscoped package name
  `dsh-google-search-plugin` as the loader entry's `name`. After the publish
  moved to the scoped name `@redknox/dsh-google-search-plugin`, a registry
  install failed at boot with `Cannot find package 'dsh-google-search-plugin'`.
  The patch now references the scoped name.

## 0.1.0 (2026-08-26)

First release candidate. The plugin ships as a DSH-native installable bundle:
`dsh plugin --profile <name> add @redknox/dsh-google-search-plugin` installs the
prebuilt artifact and routes `web_search` through Google with no further
configuration.

### Added

- **DSH profile bundle packaging** (Issue #8): `dsh.bundle` metadata, the
  `cordis.patch.yml` patch layer, publish metadata (name/version/license,
  `publishConfig.access: public`), and the 16-file prebuilt artifact.
- **Active on install**: the bundle patch layer registers the `google-search`
  provider on the `ctx.web` seam **and** sets `searchProvider: google` on the
  `web` row. Bundle layers apply in `dsh.profile.bundles` order after
  `@deepseek-ai/dsh-base`, so installing the plugin activates the Google
  route. A profile's own `cordis.patch.yml` `web` row overrides it (escape
  hatch); removing the plugin reverts the default route automatically.
- **Committed `package-lock.json`** with a consistency gate:
  `scripts/check-lock-consistency.mjs` (`npm run check-lock`, wired into
  `npm run check` and `prepublishOnly`) fails the build when the lock root
  diverges from the manifest (name, version, license, `dependencies`,
  `peerDependencies`, `devDependencies`).
- **Fresh-home install verification** (`scripts/verify-fresh-install.mjs`):
  boots a throwaway DSH_HOME, installs the packed tarball through the real
  `dsh plugin` path, and asserts install, zero-config activation, installed-copy
  resolution, live search (with a key), the profile-layer escape hatch, and
  removal — the reproducible evidence for the Issue #8 acceptance report.
- **CI** (`.github/workflows/ci.yml`): clean `npm ci` from the committed
  lockfile plus `npm run check` on every push to `main` and every pull
  request.

### Changed

- **Backend migration** (Issue #7): the Google backend moved from the Custom
  Search JSON API (being retired by Google, closed to new customers) to the
  Gemini API `google_search` grounding tool. The settings surface was
  re-targeted: `apiKeyEnv` defaults to `GEMINI_API_KEY`, and the
  Custom-Search-only settings (`engineId`, `maxResults`, `language`, `region`,
  `safeSearch`) were removed — the grounding API exposes no per-request
  control for them. Live verification is recorded in
  [E2E_VERIFICATION.md](E2E_VERIFICATION.md).

### Fixed

- **Stale `package-lock.json`** (Issue #8 review, P0): the committed lock
  still described the pre-Issue-#8 manifest (`UNLICENSED`, no `schemastery`
  dependency, `dsh-llm` as a peer, `dsh-timeout` missing), making the release
  inputs non-reproducible under `npm ci`. Regenerated from the final manifest
  and guarded by the consistency gate above.
