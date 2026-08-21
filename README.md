# dsh-google-search-plugin

A **DeepSeek Harness (DSH) plugin** that gives the agent a working web-search tool by
registering **Google** as the first planned search backend behind DSH's web capability
seam (`ctx.web`).

This repository is the home of the plugin's engineering and architecture contracts, and,
in later issues, its runtime implementation.

## What this plugin is

- A **DSH plugin** that integrates with the DeepSeek Harness [web capability seam](ARCHITECTURE.md)
  (`ctx.web`, owned by `@deepseek-ai/dsh-web`).
- It registers a **search provider** — a small adapter that turns a normalized search
  request into a Google search call and maps Google's response back to the normalized
  search result.
- **Google** is the **initial planned backend for the MVP** (the first planned search
  backend). The initial target is Google Programmable Search — Custom Search JSON API
  semantics; the concrete Google search product/API is an **adapter-layer choice** and
  not part of the domain contract.
- Its runtime configuration requires an **API credential** and, where the selected Google
  product requires it, a **search engine id (`cx`)** — supplied at runtime, never
  committed (see [ARCHITECTURE.md](ARCHITECTURE.md), "Initial Google backend target
  (MVP)").
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
| `src/index.ts` | Plugin entry (Issues #2, #6): registers the Google search provider on the `ctx.web` seam through public DSH/Cordis contracts, carries the `Config` schema, and installs the `google-search` settings section (re-read per search). |
| `src/provider/google.ts` | The Google search provider (Issues #2, #4, #6): the real `WebSearchProvider` for the `ctx.web` seam — resolves the credential and engine id per operation (literal config → Harness credentials → launching environment → process environment), applies the configured behavior settings (`maxResults`, `language`, `region`, `safeSearch`, `requestTimeoutMs`), translates the seam request into a Google Custom Search call, normalizes the response, and maps every failure onto a structured `WebError`. |
| `src/provider/config.ts` | Configuration and credential handling (Issues #4, #6): the schemastery `Config` schema (non-secret settings with defaults + descriptions, and a `role("secret")` `apiKey` field), per-operation credential resolution (literal → Harness credentials → launching environment → process environment), engine-id resolution, and the `available()` path-exists check. Names documented, values never committed. |
| `src/provider/transport.ts` | Google provider edge (Issues #4, #6): request URL serialization (endpoint + `key`/`cx`/`q`/`num`/`lr`/`gl`/`safe`), the fetch transport (injectable for tests), status/reason-based error classification (including `TimeoutReason` from the provider's `requestTimeoutMs` deadline), and a credential-safe cause chain (the raw transport error is never chained — URL tokens are scrubbed because the request URL carries the API key). The only place that knows the Google endpoint and parameter set. |
| `src/provider/normalize.ts` | Google-response → DSH seam mapping (Issues #3, #4): translates a parsed Google Custom Search response into the `@deepseek-ai/dsh-web` `WebSearchResult`/`WebSearchSource` types. The only place that knows Google's wire field names; optional fields stay absent, an *absent* `items` field (Google's real zero-result wire shape) is a valid empty result, and `truncated` is left to the seam. |
| `src/provider/errors.ts` | Google-failure → `WebError` mapping (Issue #3): classifies a Google search failure into a DSH `WebError` with a machine-routable string code, reusing the DSH shared taxonomy where it exists. No closed local error taxonomy. |
| `test/` | Offline tests: plugin registration/discovery/teardown, conformance of the normalization and error mapping to the DSH seam types, the full adapter (request serialization, normalization, empty results, and every failure path), end-to-end tool wiring (Issue #5): the real `web_search` tool (`@deepseek-ai/dsh-tool-web`), registry, seam, and cooperative-timeout policy composed with the real Google provider, driven through `ctx.tools.execute`, and configuration/credential handling (Issue #6): schema defaults and validation, the `redactSecrets` isolation contract, per-operation credential resolution order, `available()` path semantics, and the settings section against a real `FileSettingsProvider` — all against injected mock transports, mock credential/launch-environment services, and fixture values. No network, no live credentials. |
| `package.json` / `tsconfig*.json` | ESM package + TypeScript build/test configuration (Node >= 24). |

## Development

Node.js **>= 24** is required.

```sh
npm install          # install dependencies (no network needed at test time)
npm run check        # typecheck + build + run the full test suite
```

Individual steps:

```sh
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
carries a schemastery `Config` schema (validated by the Harness at load) and a
`google-search` settings section (via `@deepseek-ai/dsh-settings`) that the
provider re-reads on every search, so a settings change applies without a
reload.

**Non-secret settings** (every field carries a user-facing description; the
defaults preserve the simplest usable search):

| Setting | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `GOOGLE_SEARCH_API_KEY` | The name of the environment variable (or Harness credential reference) that holds the API key. The *name* is a setting; the *value* is never one. |
| `engineId` | `""` | The Programmable Search Engine id (`cx`). Blank falls back to the `GOOGLE_SEARCH_ENGINE_ID` environment variable. |
| `maxResults` | `10` | Default result count per search (1–10, the API maximum). A per-request `maxResults` bound still clamps it. |
| `safeSearch` | `"off"` | `"off"` or `"active"`. Only `"active"` is sent to Google (`safe=active`); `"off"` is Google's own default and is omitted. |
| `language` | `""` | Optional result-language preference, sent as `lr` (e.g. `lang_ja`). Blank omits the parameter. |
| `region` | `""` | Optional country/region preference, sent as `gl` (e.g. `US`). Blank omits the parameter. |
| `requestTimeoutMs` | `30000` | Per-request timeout in milliseconds (minimum 1000). Expiry fails the search with a stable `TIMEOUT` error. |

**Credential handling** (ENGINEERING.md §4 — values are **never committed** and
never stored in ordinary settings). The API key is resolved **per operation**,
in this order:

1. a literal `apiKey` config value (a `role("secret")` schema field, present
   only for hosts without a credential facility — it is stripped from every
   settings surface by the `redactSecrets` contract and is never written to the
   settings file);
2. the Harness credential facilities (`ctx.credentials.resolve`);
3. the launching environment snapshot;
4. the process environment.

The engine id (`cx`) is a non-secret value: the `engineId` setting, then the
`GOOGLE_SEARCH_ENGINE_ID` environment variable.

When no resolution path exists for a required value, the provider registers but
reports `available()` `false` (the seam keeps reporting the capability as
unavailable), and a direct `search()` call fails with a structured
`MISSING_CREDENTIAL` error naming the setting and the environment variable to
fix — never a value.

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
  request serialization against the documented Custom Search JSON API, response
  normalization, stable failure mapping (auth/config, quota/rate-limit,
  timeout/cancel, provider error, malformed response), runtime configuration from
  environment variables, and offline tests with mock transports. The existing
  `web_search` tool (owned by `@deepseek-ai/dsh-tool-web`) reports the capability
  as available once the runtime configuration is supplied.
- **Issue #5** (approved): the Google backend wired into the Harness tool
  contract — end-to-end tests that compose the **real** `web_search` tool
  (`@deepseek-ai/dsh-tool-web`), the tool registry, the `ctx.web` seam, and the
  cooperative-timeout policy with the real Google provider, and drive the tool
  through `ctx.tools.execute` (success, `maxResults` bound, multi-query merge,
  empty results, invalid input, provider failures, cancellation, and timeout).
  The plugin stays provider-only; the tool contract remains Google-neutral.
- **Issue #6** (in progress, pending review): secure configuration and
  credential handling — a schemastery `Config` schema for the non-secret
  settings (result limit, language/region/safe-search, request timeout) with
  user-facing descriptions and defaults that preserve the simplest usable
  search; the API key kept out of ordinary settings (a `role("secret")` field
  redacted on every settings surface, resolved per operation through the
  Harness credential facilities or an environment-backed reference);
  actionable, stable `MISSING_CREDENTIAL` failures that name the setting and
  the environment variable; and tests proving credential isolation and
  validation.
- Live end-to-end verification against the real Google API arrives in a later
  issue (#7); until then the wording stays *planned*, not *validated*.
