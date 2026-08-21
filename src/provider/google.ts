/**
 * The Google search provider for the `ctx.web` seam (Issues #2, #4).
 *
 * This plugin is **provider-only** (ARCHITECTURE.md): it registers a
 * `WebSearchProvider` on `ctx.web` (`@deepseek-ai/dsh-web`). The model-facing
 * `web_search` tool — its schema, rendering, and prompt guidance — is owned by
 * `@deepseek-ai/dsh-tool-web`; this plugin does not reimplement or shadow it.
 *
 * Stage for Issue #4: the **real adapter**. `search()` translates the seam's
 * `WebSearchRequest` into a Google Custom Search JSON API call (the provider
 * edge, `./transport.ts`), normalizes the response onto the seam's
 * `WebSearchResult` (`./normalize.ts`), and maps every failure path onto a
 * structured `WebError` (`./errors.ts`). Google's wire format stays inside
 * this adapter layer and never leaks into the seam (ENGINEERING.md §1).
 *
 * Configuration is runtime-only (ENGINEERING.md §4): the API credential and
 * the search engine id (`cx`) are read from environment variables at
 * provider-construction time (see `./config.ts` for the documented names).
 * `available()` is the cheap local check the seam contract requires —
 * configuration present — and makes **no network calls**.
 *
 * Cancellation: the seam's `signal` is forwarded to the transport; an aborted
 * caller produces a structured `ABORTED` (or `TIMEOUT` when the abort reason
 * is a `TimeoutError`), never a hang and never a success-shaped result.
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from "@deepseek-ai/dsh-web";

import {
	GOOGLE_SEARCH_API_KEY_ENV,
	GOOGLE_SEARCH_ENGINE_ID_ENV,
	resolveGoogleSearchConfig,
	type GoogleSearchConfig
} from "./config.js";
import { mapGoogleSearchFailure } from "./errors.js";
import {
	defaultGoogleHttpTransport,
	googleNumForMaxResults,
	performGoogleSearch,
	type GoogleHttpTransport
} from "./transport.js";

/** Stable provider id, unique within the search capability kind. */
export const GOOGLE_SEARCH_PROVIDER_ID = "google";

/**
 * Options for building the Google search provider.
 *
 * Both fields are injectable for tests: `env` is the env source the runtime
 * configuration is resolved from (defaults to `process.env`), and
 * `transport` is the HTTP transport used for search calls (defaults to the
 * runtime's global `fetch`). Production code builds the provider with no
 * options.
 */
export interface GoogleSearchProviderOptions {
	/** Env source for the runtime configuration (defaults to `process.env`). */
	readonly env?: Record<string, string | undefined>;
	/** HTTP transport for search calls (defaults to the global `fetch`). */
	readonly transport?: GoogleHttpTransport;
}

/**
 * Build the Google search provider.
 *
 * The runtime configuration is resolved **eagerly** at construction: when a
 * required value is missing or blank, `available()` reports `false` and
 * `search()` fails with a structured `MISSING_CREDENTIAL` error naming the
 * missing environment variables (never their values). No secret is read from
 * anywhere else, and none is ever included in an error message.
 */
export function buildGoogleSearchProvider(options: GoogleSearchProviderOptions = {}): WebSearchProvider {
	const env = options.env ?? process.env;
	const transport = options.transport ?? defaultGoogleHttpTransport;
	const { config, missing } = resolveGoogleSearchConfig(env);

	const missingMessage =
		`google search provider is not configured: missing ${missing
			.map((name) => `environment variable ${name}`)
			.join(" and ")} (set them at runtime; never commit them)`;

	return {
		id: GOOGLE_SEARCH_PROVIDER_ID,
		// Cheap local usability check, no network calls (seam contract).
		available: () => config !== undefined,
		async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
			if (config === undefined) {
				throw mapGoogleSearchFailure("missing_credential", missingMessage);
			}
			const num = googleNumForMaxResults(request.maxResults);
			const requestOptions =
				num === undefined
					? { apiKey: config.apiKey, cx: config.cx, query: request.query }
					: { apiKey: config.apiKey, cx: config.cx, query: request.query, num };
			return performGoogleSearch(requestOptions, transport, signal);
		}
	};
}
