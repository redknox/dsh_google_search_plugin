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
5. Map Google failures to structured errors (see ENGINEERING.md §6).

The concrete Google endpoint (for example the [Custom Search
JSON API](https://developers.google.com/custom-search/v1)) is an implementation detail of
this layer. Swapping or adding a backend later means writing a new adapter — it must not
touch the domain layer or the tool layer.

### 4. Google Search API

The external, third-party API. It is **outside** the repository's contract surface:

- its wire format, rate limits, and error codes are Google's, not ours;
- its credentials are supplied at runtime via environment variables and are **never
  committed** (ENGINEERING.md §4);
- claims about its behavior require verification evidence (ENGINEERING.md §5).

## Google is the first planned backend, not the domain contract

**Google is the initial backend for the MVP (the first planned search backend) — not the
internal domain contract.** The domain contract is the provider-neutral search seam
described in §2. Google is *one* implementation of it. Consequences:

- The domain model is defined by the seam types, not by Google's response shape.
- A second backend (a different provider) is a new adapter against the same seam, not a
  refactor of the domain.
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
   - `search()` calls the Google Search API with the request's `query` and honors
     `maxResults` and `signal`;
   - maps Google results to `WebSearchSource[]` (`url`, `title?`, `snippet?`,
     `publishedAt?`), leaving absent fields `undefined`;
   - `available()` returns a cheap local check (e.g. credential present) without
     network access.
3. Credentials read from **environment variables** at runtime; a clear structured error
   when missing.
4. Tests for the mapping logic using recorded fixtures (no live network in CI).

## Non-goals (first release)

- **No Fetch/Read capability.** No `WebFetchProvider`, no page-content retrieval.
- **No multi-provider abstraction** beyond the minimum domain boundary required to avoid
  Google wire coupling (the seam already provides that boundary; this plugin adds no
  framework of its own).
- **No new model-facing tools.** Only a provider for the existing `web_search` tool.
- **No credentials storage** in settings, config defaults, or the repository.
- **No automatic follow-up fetches** of search results.
- **No UI/presentation changes.** Presentation is owned by the DSH tool layer.

## Compatibility note

The seam types referenced above are as published by `@deepseek-ai/dsh-web`
(v0.1.0-rc line) at the time this document was written. Any claim that this plugin
targets a specific DSH version requires verification evidence per ENGINEERING.md §5.
