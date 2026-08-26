# dsh-google-search-plugin

A **DeepSeek Harness (DSH) plugin** that gives the agent a working web-search tool by
registering **Google** as the first planned search backend behind DSH's web capability
seam (`ctx.web`).

This repository is the home of the plugin's engineering and architecture contracts and
its runtime implementation (all issues complete; see the Status section below).

## What this plugin is

- A **DSH plugin** that integrates with the DeepSeek Harness [web capability seam](ARCHITECTURE.md)
  (`ctx.web`, owned by `@deepseek-ai/dsh-web`).
- It registers a **search provider** — a small adapter that turns a normalized search
  request into a Google search call and maps Google's response back to the normalized
  search result.
- **Google** is the **initial planned backend for the MVP** (the first planned search
  backend). The backend is the **Gemini API `google_search` grounding tool**: the query
  is sent to a Gemini model with the `google_search` tool enabled, and the model's
  synthesized answer plus its grounding sources are mapped onto the seam. The grounding
  response is a *generated grounded answer with citations and a provider-supplied
  Search Suggestion artifact*, not a replacement SERP: the grounding chunks are
  evidence for the generated answer (in response order, not a claimed ranking), and
  the adapter preserves the grounded artifact **end to end** — the answer with inline
  citation markers plus the provider's `searchEntryPoint.renderedContent` (an
  HTML+CSS snippet) **verbatim** cross the seam as `content`. The DSH seam renders
  tool output as plain text only, so the artifact reaches the model context but is
  **not rendered as a search widget to the end user** — that display boundary is a
  **host-contract blocker**, documented in
  [ARCHITECTURE.md](ARCHITECTURE.md), "The Grounding contract", not a compliance
  achievement this plugin claims. The concrete Google
  search product/API is an **adapter-layer choice** and not part of the domain
  contract. (The original Custom Search JSON API target is being retired by Google and
  is closed to new customers — see [ARCHITECTURE.md](ARCHITECTURE.md), "Google backend
  target (MVP)".)
- Its runtime configuration requires a single **API credential** (a Gemini API key) —
  supplied at runtime, never committed (see [ARCHITECTURE.md](ARCHITECTURE.md),
  "Google backend target (MVP)").
- It speaks the stable, **provider-neutral search domain contract**. Google's wire
  format stays inside the adapter and never leaks into the domain model.
- It is **search-only** in its first release: it makes the model-facing `web_search`
  tool able to discover current information on the web.

## What this plugin is not

- **Not a page reader / fetcher.** Search (discovery) and Fetch/Read (retrieval of a
  specific URL's content) are **separate capabilities** on the seam. This plugin's first
  release implements **search only**; Fetch/Read is out of scope.
- **Not a new model-facing tool.** It does not invent a new tool schema. It supplies a
  **provider** to the existing `web_search` tool through `ctx.web.registerSearchProvider`.
- **Not a multi-provider abstraction layer.** Google is the first planned backend. The
  domain boundary is kept just wide enough to avoid coupling the domain model to Google's
  wire format — nothing more. That boundary is what keeps a future migration to, or
  addition of, another Google search API/product an adapter-layer change that does not
  touch the Harness-facing search domain contract.
- **Not a credentials store.** Google API credentials are supplied at runtime via
  environment variables. They are **never committed** and **never stored in ordinary
  settings** (see [ENGINEERING.md](ENGINEERING.md)).

## Repository layout

| Path | Purpose |
|---|---|
| `README.md` | Product positioning — what the plugin is and is not (this file). |
| `ENGINEERING.md` | Normative engineering principles for human and AI contributors. |
| `ARCHITECTURE.md` | The stable domain vs external-provider boundary, the initial Google backend target (MVP) and its configuration shape, the Search / Fetch-Read capability split, and first-release scope + non-goals. |
| `src/index.ts` | Plugin entry (Issues #2, #6): registers the Google search provider on the `ctx.web` seam through public DSH/Cordis contracts, carries the composition `Config` schema, and installs the `google-search` settings section from the persisted `Settings` schema (no `apiKey` field, with the `validate` hook that rejects a raw key) — re-read per search. |
| `src/provider/google.ts` | The Google search provider (Issues #2, #4, #6, #7): the real `WebSearchProvider` for the `ctx.web` seam — resolves the credential per operation (literal config → Harness credentials → launching environment → process environment), applies the configured behavior settings (`model`, `requestTimeoutMs`), translates the seam request into a Gemini `google_search` grounding call, normalizes the response, and maps every failure onto a structured `WebError`. |
| `src/provider/config.ts` | Configuration and credential handling (Issues #4, #6, #7): the schemastery `Settings` schema (the persisted, non-secret settings with defaults + descriptions — **no** `apiKey` field) and the composition `Config` schema (settings + a `role("secret")` `apiKey` accepted only as plugin composition input), the `validate` hook that rejects any settings write carrying a raw key, per-operation credential resolution (literal → Harness credentials → launching environment → process environment), and the `available()` path-exists check. Names documented, values never committed. |
| `src/provider/transport.ts` | Google provider edge (Issues #4, #6, #7): the Gemini grounding request (endpoint + model + prompt + `google_search` tool, the API key in the `x-goog-api-key` header — the URL carries no credential), the fetch transport (injectable for tests), status/reason-based error classification (including `TimeoutReason` from the provider's `requestTimeoutMs` deadline), and a credential-safe cause chain (the raw transport error is never chained — URL tokens are scrubbed). The only place that knows the Gemini endpoint and wire shape. |
| `src/provider/normalize.ts` | Google-response → DSH seam mapping (Issues #3, #4, #7): translates a parsed Gemini grounding response into the `@deepseek-ai/dsh-web` `WebSearchResult`/`WebSearchSource` types. The only place that knows the Gemini wire field names; the grounded artifact is preserved end to end — the answer (with inline `[n]` citation markers from `groundingSupports`) plus the provider-supplied Search Suggestion artifact (`searchEntryPoint.renderedContent`, preserved **verbatim**, never reconstructed from `webSearchQueries`) map to `content`, and the grounding chunks (evidence in response order, not a claimed ranking) map to `sources` (deduped by URL). Optional fields stay absent, an *absent* `groundingMetadata` field carries zero grounding sources (a valid zero-source result — the wire does not say whether a search ran and found nothing), and `truncated` is left to the seam. |
| `src/provider/errors.ts` | Google-failure → `WebError` mapping (Issue #3): classifies a Google search failure into a DSH `WebError` with a machine-routable string code, reusing the DSH shared taxonomy where it exists. No closed local error taxonomy. |
| `test/` | Offline tests: plugin registration/discovery/teardown, conformance of the normalization and error mapping to the DSH seam types, the full adapter (request serialization, normalization, empty results, and every failure path), end-to-end tool wiring (Issue #5): the real `web_search` tool (`@deepseek-ai/dsh-tool-web`), registry, seam, and cooperative-timeout policy composed with the real Google provider, driven through `ctx.tools.execute`, and configuration/credential handling (Issue #6): schema defaults and validation, the `redactSecrets` read-surface isolation contract, per-operation credential resolution order, `available()` path semantics, and the settings section against a real `FileSettingsProvider` — including a regression test that a raw `apiKey` submitted through the ordinary settings update path is rejected by the `validate` hook and never written to disk — all against injected mock transports, mock credential/launch-environment services, and fixture values. No network, no live credentials. |
| `cordis.patch.yml` | The bundle patch layer (Issue #8): the `insert` that mounts this package as a DSH profile bundle — it registers the Google search provider on the `ctx.web` seam and sets `searchProvider: google` on the `web` row, so the bundle is active on install (the profile layer can still override it). Declared by `dsh.bundle.patch` in `package.json`; DSH tooling reads it to reconcile the package into a profile's layer stack. |
| `LICENSE` | MIT license (Issue #8). |
| `package-lock.json` | The npm lock (Issue #8): the committed install contract for `npm ci`. Its root entry must stay in sync with `package.json` — `npm run check-lock` enforces this in every `npm run check` and `prepublishOnly` run, so a dependency-role change cannot silently leave the lock stale. |
| `scripts/check-lock-consistency.mjs` | Release verification (Issue #8): asserts the committed `package-lock.json` root matches `package.json` (name, version, license, `dependencies`, `peerDependencies`, `devDependencies`); fails the build with a regenerate hint when they diverge. |
| `scripts/verify-fresh-install.mjs` | Fresh-home install verification (Issue #8 evidence, ENGINEERING.md §5): boots a throwaway DSH_HOME, installs the packed tarball through the real `dsh plugin` path, and asserts install, zero-config activation, installed-copy resolution, live search (with a key), the profile-layer escape hatch, and removal. Manual release-time gate (needs the dsh CLI, pnpm, and a live key). |
| `.github/workflows/ci.yml` | Continuous verification: clean `npm ci` from the committed lockfile plus `npm run check` on every push to `main` and pull request. |
| `CHANGELOG.md` | Notable changes per release. |
| `package.json` / `tsconfig*.json` | ESM package + TypeScript build/test configuration (Node >= 24). `package.json` carries the DSH bundle metadata (`dsh.bundle.patch`), the publish metadata (name `dsh-google-search-plugin`, version, `publishConfig.access: public`), and the dependency split that keeps a single Harness/Cordis runtime identity: every `@deepseek-ai/cordis` / `@deepseek-ai/dsh-*` framework package is a **peer** dependency (one shared copy, provided by the host profile's `@deepseek-ai/dsh-base`), while `@deepseek-ai/schemastery` is a plain dependency. |

## Development

Node.js **>= 24** is required.

```sh
npm install          # install dependencies (no network needed at test time)
npm run check        # lock consistency + typecheck + build + run the full test suite
```

Individual steps:

```sh
npm run check-lock   # assert package-lock.json matches package.json (release gate)
npm run typecheck    # tsc --noEmit over src + test
npm run build        # compile src/ -> lib/ (package output)
npm test             # compile src + test, then run node --test on the compiled JS
```

The test suite is **offline**: it exercises the plugin's registration through a bare
Cordis `Context` and the Google adapter end to end against injected mock transports
and fake fixture values, asserting conformance to the DSH seam types. It makes
**no** Google requests and needs **no** credentials.

### Runtime configuration

The plugin is configurable **without editing runtime source** (Issue #6): it
carries a schemastery `Config` schema for its composition input (validated by
the Harness at load) and a `google-search` settings section (via
`@deepseek-ai/dsh-settings`) built from the persisted `Settings` schema — which
has no `apiKey` field — that the provider re-reads on every search, so a
settings change applies without a reload.

**Non-secret settings** (every field carries a user-facing description; the
defaults preserve the simplest usable search):

| Setting | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `GEMINI_API_KEY` | The name of the environment variable (or Harness credential reference) that holds the Gemini API key. The *name* is a setting; the *value* is never one. |
| `model` | `gemini-3.6-flash` | The Gemini model that performs the grounded search. Pattern-validated (`[a-z0-9][a-z0-9._-]*`). |
| `requestTimeoutMs` | `30000` | Per-request timeout in milliseconds (minimum 1000). Expiry fails the search with a stable `TIMEOUT` error. |

The previous Custom Search settings (`engineId`, `maxResults`, `language`,
`region`, `safeSearch`) were **removed** with the backend migration (Issue #7):
the Gemini grounding API exposes no per-request engine id, result count,
language, region, or SafeSearch control, so keeping them would be dead
configuration. The per-request result bound is still enforced by the DSH seam
on the way back (its `maxResults`), and language/region/SafeSearch are
**not supported** by this backend — documented, not claimed.

**Credential handling** (ENGINEERING.md §4 — values are **never committed** and
never stored in ordinary settings). The API key is resolved **per operation**,
in this order:

1. a literal `apiKey` config value (a `role("secret")` schema field on the
   plugin's *composition* `Config`, present only for hosts without a credential
   facility). It is accepted **only** as the value handed to `ctx.plugin(...)`
   and is passed straight to the provider — it is *not* part of the persisted
   settings schema and is never registered with the settings service, so it can
   never be written to the settings file. It is also stripped from every *read*
   surface by the `redactSecrets` contract.
2. the Harness credential facilities (`ctx.credentials.resolve`);
3. the launching environment snapshot;
4. the process environment.

The persisted settings schema (the `google-search` settings section) contains
**no** `apiKey` field, and a `validate` hook rejects any write that carries one
*before* the section is persisted. This is what guarantees — and the
`FileSettingsProvider` regression test proves — that the ordinary
`ctx.settings.update()` path cannot place a raw key on disk.

When no resolution path exists for a required value, the provider registers but
reports `available()` `false` (the seam keeps reporting the capability as
unavailable), and a direct `search()` call fails with a structured
`MISSING_CREDENTIAL` error naming the setting and the environment variable to
fix — never a value.

## Installation (DSH profile bundle)

This package is a **DSH-native profile bundle** (Issue #8): a plain npm package
that declares `dsh.bundle.patch` in its `package.json` and ships a
[cordis.patch.yml](cordis.patch.yml) patch layer. DSH tooling
(`dsh plugin …`, the profile boot path) recognizes the declaration, installs
the package into the profile's own `node_modules`, and reconciles it into the
profile's `dsh.profile.bundles` layer list — no local checkout, symlink, or
absolute source path is involved.

**Install into a profile** (e.g. the `web` profile):

```sh
dsh plugin --profile web add dsh-google-search-plugin
```

`dsh plugin` forwards to `pnpm` in the profile directory, then reconciles:
because the installed package declares `dsh.bundle`, it is appended to the
profile's `dsh.profile.bundles` list and its `cordis.patch.yml` becomes a patch
layer applied after the base bundle and before the profile's own
`cordis.patch.yml`.

**Active on install.** The bundle's patch layer both registers the provider on
the `ctx.web` seam and sets `searchProvider: google` on the `web` service row.
Bundle layers apply in `dsh.profile.bundles` order — this bundle is listed
after `@deepseek-ai/dsh-base` — so the row overrides the base bundle's
`deepseek-official` default: installing the plugin routes `web_search` through
Google with **no further configuration**.

**Switching the default route back.** A profile that wants to keep (or restore)
the DeepSeek search route adds its own `web` row to the profile's
`cordis.patch.yml`; the profile layer always applies after every bundle layer
and wins:

```yaml
- id: web
  config:
    searchProvider: deepseek-official
```

(If the profile has no `GEMINI_API_KEY`, the activated Google route fails with
a structured `MISSING_CREDENTIAL` error naming the variable — clear and
actionable, never a silent route change.)

**Supply the credential.** Set the environment variable named by the
`google-search` settings section's `apiKeyEnv` (default `GEMINI_API_KEY`) for
the process that boots the profile — or a Harness credential reference of the
same name. Never put the key in the patch file or the settings file
(ENGINEERING.md §4).

**Remove / reinstall:**

```sh
dsh plugin --profile web remove dsh-google-search-plugin   # pnpm removes it; reconciliation drops the bundle row
dsh plugin --profile web add dsh-google-search-plugin      # re-adds it and re-activates the bundle row
```

**Package contents.** The published artifact contains only what a fresh profile
install needs: the compiled runtime (`lib/`), its type declarations, this
README, the MIT `LICENSE`, the bundle patch file, and the manifest. No source
tree, no tests, no build caches, no local paths, no credentials.

## Publishing

Publication to the npm registry is a separate, explicitly authorized action
(not part of any issue round). The metadata is in place and the dry-run gate
is wired:

```sh
npm publish --dry-run    # verifies the artifact; publishes nothing
```

`prepublishOnly` re-runs `npm run check` (typecheck + build + offline tests)
before any real publication.

`npm run check` starts with `npm run check-lock`
([scripts/check-lock-consistency.mjs](scripts/check-lock-consistency.mjs)),
which asserts the committed `package-lock.json` root still matches
`package.json` (name, version, license, `dependencies`, `peerDependencies`,
`devDependencies`). A stale lock makes `npm ci` install a different dependency
contract than the manifest describes, so the check fails the build until the
lock is regenerated with `npm install --package-lock-only`.

CI (`.github/workflows/ci.yml`) runs a clean `npm ci` from the committed
lockfile plus `npm run check` on every push to `main` and pull request — the
stale-lockfile regression is caught automatically, before review.

The full release verification path is therefore: regenerate the lock when the
manifest's dependency contract changes, let CI verify the clean install, run
[scripts/verify-fresh-install.mjs](scripts/verify-fresh-install.mjs) for the
fresh-home install/activation/removal evidence (needs the dsh CLI, pnpm, and a
live `GEMINI_API_KEY`), then re-run `npm pack --dry-run` and
`npm publish --dry-run` from the clean install.

## Status

- **Issue #1** (closed): project-level contracts — this file, `ENGINEERING.md`, and
  `ARCHITECTURE.md`.
- **Issue #2** (approved): the plugin loads through public DSH/Cordis contracts and
  registers a `WebSearchProvider` on the `ctx.web` seam (`@deepseek-ai/dsh-web`).
- **Issue #3** (approved): the Google-adapter mapping helpers — Google-response →
  DSH seam `WebSearchResult`/`WebSearchSource` normalization and Google-failure →
  `WebError` error mapping, using the public `@deepseek-ai/dsh-web` types as the
  stable contract (no parallel domain) — with offline conformance tests.
- **Issue #4** (approved): the real Google search backend adapter —
  request serialization against the documented wire API, response
  normalization, stable failure mapping (auth/config, quota/rate-limit,
  timeout/cancel, provider error, malformed response), runtime configuration from
  environment variables, and offline tests with mock transports. The existing
  `web_search` tool (owned by `@deepseek-ai/dsh-tool-web`) reports the capability
  as available once the runtime configuration is supplied. (Issue #7 re-targeted
  the backend from the Custom Search JSON API to the Gemini `google_search`
  grounding tool; the adapter contract is unchanged.)
- **Issue #5** (approved): the Google backend wired into the Harness tool
  contract — end-to-end tests that compose the **real** `web_search` tool
  (`@deepseek-ai/dsh-tool-web`), the tool registry, the `ctx.web` seam, and the
  cooperative-timeout policy with the real Google provider, and drive the tool
  through `ctx.tools.execute` (success, `maxResults` bound, multi-query merge,
  empty results, invalid input, provider failures, cancellation, and timeout).
  The plugin stays provider-only; the tool contract remains Google-neutral.
- **Issue #6** (approved): secure configuration and
  credential handling — a schemastery `Settings` schema for the persisted
  non-secret settings with user-facing descriptions and defaults that preserve
  the simplest usable search; the API key kept out of ordinary settings **by
  design** — the persisted `Settings` schema has no `apiKey` field, the literal
  key is accepted only as plugin composition input (a `role("secret")` field on
  the composition `Config`, stripped from every read surface), a `validate`
  hook rejects any settings write carrying a raw key before it is persisted,
  and the key is resolved per operation through the Harness credential
  facilities or an environment-backed reference; actionable, stable
  `MISSING_CREDENTIAL` failures that name the setting and the environment
  variable; and tests proving credential isolation and validation, including a
  `FileSettingsProvider` regression test that a raw key submitted through the
  ordinary settings path is rejected and never reaches disk. (The Issue #7
  migration re-targeted the settings surface to the Gemini backend: `apiKeyEnv`
  now defaults to `GEMINI_API_KEY`, and the Custom-Search-only settings were
  removed — see the settings table above.)
- **Issue #7** (closed): verify real Google Search API behavior
  end-to-end — and, in the process, migrate the backend from the Custom Search
  JSON API (being retired by Google, closed to new customers) to the Gemini
  API `google_search` grounding tool. Live verification against the real
  Gemini API through the real Harness `web_search` tool path is recorded in
  [E2E_VERIFICATION.md](E2E_VERIFICATION.md); the offline suite remains the
  no-network, no-credential path.
- **Issue #8** (approved): package and release the plugin as a DSH-native
  installable bundle — the `dsh.bundle` metadata + `cordis.patch.yml` patch
  layer (provider registration **and** `searchProvider: google` activation on
  install, with the profile layer as the override/escape hatch), the publish
  metadata (name/version/license), the prebuilt-artifact contents, the committed
  `package-lock.json` with its consistency gate (`npm run check-lock`),
  fresh-profile install/reconcile/boot/registration/remove/reinstall
  verification, and the `npm publish --dry-run` gate. Actual registry
  publication remains a separate, explicitly authorized action.
