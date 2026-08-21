# ARCHITECTURE.md — Intended Boundary

This document defines the intended architectural boundary of the plugin. It is the map;
[ENGINEERING.md](ENGINEERING.md) is the rules of the road.

## The boundary

```text
DeepSeek Harness Tool contract
        ↓
Search domain
        ↓
Search provider adapter
        ↓
Google Search API
```

Each line is a **seam**: contracts cross it, implementation details do not.

### 1. DeepSeek Harness Tool contract

The model-facing tool layer of DeepSeek Harness (DSH). Concretely, the
`web_search` tool owned by `@deepseek-ai/dsh-tool-web`, which:

- owns the tool name, JSON schema, argument validation, result-count bound, result
  formatting, and UI presentation;
- **never** imports a concrete provider; its only execution path is
  `ctx.web.search()` on the web capability seam (`@deepseek-ai/dsh-web`);
- registers stably regardless of provider availability — an enabled tool stays visible
  and fails with a structured error at execution time if no usable provider exists.

This layer is **not something this plugin re-implements**. The plugin plugs into it.

### 2. Search domain

The **stable, provider-neutral** search contract. This is the seam owned by
`@deepseek-ai/dsh-web` (`ctx.web`), and the types this plugin's adapter implements:

```text
WebSearchRequest  { query, maxResults? }
WebSearchResult   { content?, sources[], truncated }
WebSearchSource   { url, title?, snippet?, publishedAt? }
WebSearchProvider { id, available(), search(request, signal?) }
```

Invariants of the domain layer:

- **Provider-neutral.** No field name, endpoint, or error code of any specific search
  provider may appear here.
- **Optional means optional.** `title`, `snippet`, `publishedAt`, and `content` are
  optional because not every provider returns them. Adapters **MUST NOT** invent values
  to fill them (see ENGINEERING.md §2 — no silent `unknown → false`).
- **One owner.** Provider selection, cancellation, and error shaping have exactly one
  owner: the seam. The adapter never selects providers; the tool never sees providers.

### 3. Search provider adapter

The plugin's own code — the **only** layer in this repository that may know about a
specific provider. Its job:

1. Register a `WebSearchProvider` with `ctx.web.registerSearchProvider(...)`.
2. Translate a `WebSearchRequest` into a Google search call.
3. Translate Google's response into a `WebSearchResult`, mapping only fields Google
   actually returns and leaving absent fields `undefined`.
4. Report a cheap, local `available()` (no network calls) and forward `signal` for
   cancellation.
5. Map Google failures to structured errors (see ENGINEERING.md §7).

The concrete Google search **product/API** is an **adapter-layer choice**. The initial
target for the MVP is Google Programmable Search — Custom Search JSON API (recorded in
"Initial Google backend target (MVP)" below). Swapping or adding a backend later —
including migrating to another Google search API/product — means writing a new (or
re-pointed) adapter against the same seam; it must not touch the domain layer or the tool
layer.

### 4. Google Search API

The external, third-party API. It is **outside** the repository's contract surface:

- its wire format, rate limits, and error codes are Google's, not ours;
- its credentials are supplied at runtime via environment variables and are **never
  committed** (ENGINEERING.md §4);
- claims about its behavior require verification evidence (ENGINEERING.md §5).

## Initial Google backend target (MVP)

The initial Google backend target for the MVP is **Google Programmable Search —
[Custom Search JSON API](https://developers.google.com/custom-search/v1) semantics**: a
REST search endpoint that takes a query string and returns a list of result items with
url, title, and snippet fields, which map onto `WebSearchSource`.

**Configuration shape (contract, not values).** The adapter is configurable
**without editing runtime source**: it carries a declarative configuration schema
(validated by the Harness at load) and a settings section that the provider re-reads
on every search. The schema splits into two kinds of field:

| Setting | Kind | Notes |
|---|---|---|
| API credential | secret, runtime-only | Resolved **per operation** from, in order: a literal secret config value, the Harness credential facilities, the launching environment, then the process environment. **Never committed**, and never stored in ordinary settings (ENGINEERING.md §4). The literal value is a `role("secret")` field stripped from every settings surface; the recommended path is an environment-backed reference (the *name* of the variable is a setting, the *value* is not). This document names the *shape* of the requirement, not a specific variable name, and never a value. |
| Search engine id (`cx`) | non-secret, runtime-only | Required where the selected Google product requires it (Custom Search JSON API requires a `cx` identifying the Programmable Search Engine). A non-secret setting that falls back to an environment variable. Environment-specific ids are deployment data, **not** repository contract data: no real `cx` value is recorded here or in any checked-in default. |
| Behavior settings | non-secret, have defaults | Request-shaping settings (result-limit default, language/region/safe-search, request timeout). Every field carries a user-facing description and a default that preserves the simplest usable search; they are ordinary settings (not secrets) and are persisted like any other non-secret setting. |

Recorded here is the **shape** of the configuration (a secret credential + a non-secret
engine id + non-secret behavior settings, each with a documented resolution/default
rule). Real credential values and environment-specific ids are deployment data and must
not appear in this repository's contract documents, config defaults, or examples. When
no resolution path exists for a required value, the provider reports itself
unavailable and a search fails with a stable, actionable error that names the setting
and the environment variable to fix — never a value.

**Adapter-layer choice.** The concrete Google search product/API is an adapter-layer
choice, not a domain decision. A future migration to, or addition of, another Google
search API/product (for example a different Google search endpoint with different
parameters, pagination, or result fields) is an adapter concern: it is expressed as a new
or re-pointed adapter behind the same `WebSearchProvider` interface, and **must not
require changes to the Harness-facing search domain contract** (the seam types in §2).
This issue records that boundary only; it does **not** implement multiple Google APIs or
a Google-API abstraction layer (see Non-goals).

## Google is the first planned backend, not the domain contract

**Google is the initial backend for the MVP (the first planned search backend) — not the
internal domain contract.** The domain contract is the provider-neutral search seam
described in §2. Google is *one* implementation of it. Consequences:

- The domain model is defined by the seam types, not by Google's response shape.
- A different search provider (another vendor) is a new adapter against the same seam,
  not a refactor of the domain.
- A **future Google search API/product variant** (a different Google search endpoint or
  product, with different parameters, pagination, or result fields) is likewise an
  adapter-layer change: a new or re-pointed adapter behind the same `WebSearchProvider`
  interface. The Harness-facing search domain contract stays stable across Google API
  variants; migrating between them must not change the seam types in §2 or the
  tool-facing contract in §1.
- Nothing in layers 1–2 may depend on Google. The dependency arrow points one way only:
  adapter → Google.

> **Evidence-matched wording.** As of Issue #1 (contracts only) there is no runtime
> implementation and no live Google API call, so Google is described as *planned* /
> *initial*, not *validated*. Per ENGINEERING.md §5, the wording is upgraded to
> "validated" only once real Google API + Harness E2E evidence exists (Issue #7).

## Search and Fetch/Read are separate capabilities

DSH's web seam deliberately exposes **two independent capabilities** with separate
request/result types:

| Capability | Seam method | Provider interface | Tool | This plugin (first release) |
|---|---|---|---|---|
| **Search** (discovery) | `ctx.web.search()` | `WebSearchProvider` | `web_search` | **In scope** |
| **Fetch/Read** (retrieval) | `ctx.web.fetch()` | `WebFetchProvider` | `web_fetch` | **Out of scope** |

They share one seam so provider selection, cancellation, errors, and configuration have
one owner — but they are **separate capabilities**: separate request types, separate
result types, separate provider registration, and independent enablement. A search
result is a list of citeable sources; a fetch result is the content of one specific URL.
Conflating them (e.g. "fetching" each search hit automatically) is a capability
violation and out of scope for the first release.

## First release scope

The first release (MVP) delivers exactly:

1. A DSH plugin that registers **one search provider** against `ctx.web`.
2. A Google adapter implementing `WebSearchProvider`:
   - `search()` calls the Google Search API with the request's `query`, honors
     `maxResults` and `signal`, and applies the configured behavior settings
     (result-limit default, language/region/safe-search, request timeout);
   - maps Google results to `WebSearchSource[]` (`url`, `title?`, `snippet?`,
     `publishedAt?`), leaving absent fields `undefined`;
   - `available()` returns a cheap synchronous check — whether a **resolution path**
     exists for every required value (a credential source and an engine-id source) —
     without network access; the actual per-operation resolution happens in `search()`.
3. Runtime configuration per the shape recorded in "Initial Google backend target
   (MVP)": a secret API credential (resolved per operation, never stored in ordinary
   settings) and, where the selected Google product requires it, a non-secret search
   engine id (`cx`) — both supplied at runtime, never committed — plus non-secret
   behavior settings with defaults and user-facing descriptions; a clear structured
   error naming the setting and environment variable when a value is missing.
4. Tests for the mapping logic using recorded fixtures (no live network in CI), and
   configuration tests covering credential isolation and validation (Issue #6).

## Non-goals (first release)

- **No Fetch/Read capability.** No `WebFetchProvider`, no page-content retrieval.
- **No claim that the Google backend is validated/verified.** That wording is reserved
  for after live verification provides evidence (Issue #7).
- **No implementation of multiple Google APIs** in this issue. Only the adapter boundary
  is preserved so a future migration to, or addition of, another Google search
  API/product can be done without touching the domain contract, when a real requirement
  appears.
- **No multi-provider abstraction** beyond the minimum domain boundary required to avoid
  Google wire coupling (the seam already provides that boundary; this plugin adds no
  framework of its own).
- **No new model-facing tools.** Only a provider for the existing `web_search` tool.
- **No credentials or `cx` values** in settings, config defaults, or the repository.
- **No automatic follow-up fetches** of search results.
- **No UI/presentation changes.** Presentation is owned by the DSH tool layer.

## Compatibility note

The seam types referenced above are as published by `@deepseek-ai/dsh-web`
(v0.1.0-rc line) at the time this document was written. Any claim that this plugin
targets a specific DSH version requires verification evidence per ENGINEERING.md §5.
