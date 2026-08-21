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
| `src/index.ts` | Plugin entry (Issue #2): registers the `web_search` tool and its guidance section through public DSH/Cordis contracts. |
| `src/tool/web-search.ts` | The model-facing `web_search` tool definition (Issue #2): provider-neutral input/output, structured `capability_unavailable` failure until a backend is wired. |
| `src/domain/` | The provider-neutral search domain (Issue #3): `SearchQuery`/`SearchResult`/`SearchOutcome` types, `validateSearchQuery`, `normalizeSearchResults`, and the stable `SearchError` categories. |
| `test/` | Offline tests: plugin registration/discovery/teardown and domain semantics. No network, no credentials. |
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
Cordis `Context` and the provider-neutral search domain directly. It makes **no**
Google requests and needs **no** credentials.

## Status

- **Issue #1** (closed): project-level contracts — this file, `ENGINEERING.md`, and
  `ARCHITECTURE.md`.
- **Issue #2** (in progress, pending review): the plugin loads through public
  DSH/Cordis contracts and registers a discoverable `web_search` tool with a
  provider-neutral input and output contract. No search backend is wired in yet, so
  a call fails with a structured `capability_unavailable` error.
- **Issue #3** (in progress, pending review): the provider-neutral search domain —
  validated input semantics, normalized result semantics and ordering, and stable,
  machine-routable error categories — with offline tests.
- Live Google API calls and the concrete Google adapter arrive in later issues
  (#4–#7).

> **Architecture note (pending revision).** This implementation follows Issue #2
> literally: the plugin **registers its own `web_search` tool** via
> `@deepseek-ai/dsh-tools` `defineTool`. That conflicts with the
> "Not a new model-facing tool" / provider-only wording in this file and in
> `ARCHITECTURE.md`, which were written for the earlier `ctx.web` provider design.
> The maintainer chose the self-registering-tool path for this round; these docs
> need a post-review revision to match. Flagged here and in the commit message.
