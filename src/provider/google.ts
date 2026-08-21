/**
 * The Google search provider for the `ctx.web` seam (Issue #2).
 *
 * This plugin is **provider-only** (ARCHITECTURE.md): it registers a
 * `WebSearchProvider` on `ctx.web` (`@deepseek-ai/dsh-web`). The model-facing
 * `web_search` tool — its schema, rendering, and prompt guidance — is owned by
 * `@deepseek-ai/dsh-tool-web`; this plugin does not reimplement or shadow it.
 *
 * Stage for this issue: a **stub** provider. It proves lifecycle
 * registration/discovery/unload on the seam, but it makes **no real Google
 * request** (Issue #4 adds the adapter, Issue #6 the credential handling).
 * The stub is deliberately *unavailable*: `available()` is `false`, so the
 * seam's selection rules report the capability as unavailable rather than
 * dispatching to a provider that cannot answer. A direct call to `search()`
 * (bypassing the seam) fails with a structured {@link WebError} — never a
 * success-shaped result (ENGINEERING.md §7).
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from "@deepseek-ai/dsh-web";

/** Stable provider id, unique within the search capability kind. */
export const GOOGLE_SEARCH_PROVIDER_ID = "google";

/**
 * Build the Google search provider. Pure: no services, no network, no
 * credentials read — so the provider is inspectable and testable in
 * isolation, and no secret ever reaches this stage.
 */
export function buildGoogleSearchProvider(): WebSearchProvider {
	return {
		id: GOOGLE_SEARCH_PROVIDER_ID,
		// Cheap local usability check, no network calls (seam contract).
		// False until the real adapter is wired in (Issue #4).
		available: () => false,
		async search(_request: WebSearchRequest, _signal?: AbortSignal): Promise<WebSearchResult> {
			// Unreachable through the seam while `available()` is false —
			// the seam refuses to dispatch to an unavailable provider.
			// Defensive for direct calls: fail with the capability-unavailable
			// category, never a fabricated empty success.
			throw new WebError(
				`google search provider "${GOOGLE_SEARCH_PROVIDER_ID}" is a stub: no Google adapter is wired in yet`,
				"WEB_PROVIDER_UNAVAILABLE"
			);
		}
	};
}
