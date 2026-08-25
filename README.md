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
  backend). The backend is the **Gemini API `google_search` grounding tool**: the query
  is sent to a Gemini model with the `google_search` tool enabled, and the model's
  synthesized answer plus its grounding sources are mapped onto the seam. The grounding
  response is a *generated grounded answer with citations and Search Suggestions*, not a
  replacement SERP: the grounding chunks are evidence for the generated answer (in
  response order, not a claimed ranking), and the adapter preserves the grounded
  artifact **end to end** — the answer with inline citation markers plus the Search
  suggestions (one Google search link per model query) cross the seam as `content`,
  which is also how Google's grounding display obligation (Search Suggestions shown
  with grounded results) is met at the tool-output boundary. The concrete Google
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
| `src/provider/normalize.ts` | Google-response → DSH seam mapping (Issues #3, #4, #7): translates a parsed Gemini grounding response into the `@deepseek-ai/dsh-web` `WebSearchResult`/`WebSearchSource` types. The only place that knows the Gemini wire field names; the grounded artifact is preserved end to end — the answer (with inline `[n]` citation markers from `groundingSupports`) plus the Search suggestions (one Google search link per `webSearchQueries` entry) map to `content`, and the grounding chunks (evidence in response order, not a claimed ranking) map to `sources` (deduped by URL). Optional fields stay absent, an *absent* `groundingMetadata` field carries zero grounding sources (a valid zero-source result — the wire does not say whether a search ran and found nothing), and `truncated` is left to the seam. |
| `src/provider/errors.ts` | Google-failure → `WebError` mapping (Issue #3): classifies a Google search failure into a DSH `WebError` with a machine-routable string code, reusing the DSH shared taxonomy where it exists. No closed local error taxonomy. |
| `test/` | Offline tests: plugin registration/discovery/teardown, conformance of the normalization and error mapping to the DSH seam types, the full adapter (request serialization, normalization, empty results, and every failure path), end-to-end tool wiring (Issue #5): the real `web_search` tool (`@deepseek-ai/dsh-tool-web`), registry, seam, and cooperative-timeout policy composed with the real Google provider, driven through `ctx.tools.execute`, and configuration/credential handling (Issue #6): schema defaults and validation, the `redactSecrets` read-surface isolation contract, per-operation credential resolution order, `available()` path semantics, and the settings section against a real `FileSettingsProvider` — including a regression test that a raw `apiKey` submitted through the ordinary settings update path is rejected by the `validate` hook and never written to disk — all against injected mock transports, mock credential/launch-environment services, and fixture values. No network, no live credentials. |
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
- **Issue #7** (in progress): verify real Google Search API behavior
  end-to-end — and, in the process, migrate the backend from the Custom Search
  JSON API (being retired by Google, closed to new customers) to the Gemini
  API `google_search` grounding tool. Live verification against the real
  Gemini API through the real Harness `web_search` tool path is recorded in
  [E2E_VERIFICATION.md](E2E_VERIFICATION.md); the offline suite remains the
  no-network, no-credential path.
