/**
 * The Google search provider for the `ctx.web` seam (Issues #2, #4, #6).
 *
 * This plugin is **provider-only** (ARCHITECTURE.md): it registers a
 * `WebSearchProvider` on `ctx.web` (`@deepseek-ai/dsh-web`). The model-facing
 * `web_search` tool — its schema, rendering, and prompt guidance — is owned by
 * `@deepseek-ai/dsh-tool-web`; this plugin does not reimplement or shadow it.
 *
 * `search()` translates the seam's `WebSearchRequest` into a Google Custom
 * Search JSON API call (the provider edge, `./transport.ts`), normalizes the
 * response onto the seam's `WebSearchResult` (`./normalize.ts`), and maps
 * every failure path onto a structured `WebError` (`./errors.ts`). Google's
 * wire format stays inside this adapter layer and never leaks into the seam
 * (ENGINEERING.md §1).
 *
 * Configuration (Issue #6): the provider is built from the plugin's
 * {@link Config} section (see `./config.ts`). **Credentials are resolved per
 * operation** — a literal `apiKey` (a `role("secret")` field, never
 * persisted), then the Harness credential facilities, then the launching
 * environment, then the process environment — and are never cached on the
 * provider or stored in ordinary settings (ENGINEERING.md §4). Behavior
 * settings (result limit, language, region, SafeSearch, request timeout)
 * come from the same section and may be changed at runtime through the
 * `google-search` settings section without editing source.
 *
 * `available()` is the cheap, **synchronous** check the seam contract
 * requires: it reports whether a *resolution path* exists for every required
 * value (a path, not a value) and makes **no network calls** and no
 * asynchronous resolution. When no path yields a value, `search()` fails
 * with a structured, actionable `MISSING_CREDENTIAL` error naming the
 * missing setting/environment variable (never its value) — the canonical DSH
 * credential pattern (cf. `@deepseek-ai/dsh-web-search-deepseek`).
 *
 * Cancellation: the seam's `signal` is forwarded to the transport; an aborted
 * caller produces a structured `ABORTED` (or `TIMEOUT` when the abort reason
 * is a `TimeoutError`/`TimeoutReason`), never a hang and never a
 * success-shaped result. The `requestTimeoutMs` setting adds a provider-level
 * deadline (via `@deepseek-ai/dsh-timeout`'s `deadline()`) on top of the
 * caller's signal, so a hung Google request degrades to a stable `TIMEOUT`.
 */

import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from "@deepseek-ai/dsh-web";
import { deadline } from "@deepseek-ai/dsh-timeout";
import type { Context } from "@deepseek-ai/cordis";

import {
	Config,
	GOOGLE_SEARCH_API_KEY_ENV,
	GOOGLE_SEARCH_ENGINE_ID_ENV,
	googleSearchConfigPathExists,
	resolveGoogleSearchCredential,
	resolveGoogleSearchEngineId,
	type GoogleSearchSettings
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
 * All fields are injectable for tests: `settings` is the configuration
 * section (defaults to the schema's defaults), `env` is the env source the
 * credential/engine-id fallbacks are resolved from (defaults to
 * `process.env`), `ctx` is the plugin context supplying the credential and
 * environment planes (defaults to `undefined` — the bare provider path), and
 * `transport` is the HTTP transport used for search calls (defaults to the
 * runtime's global `fetch`). Production code builds the provider from the
 * plugin's configuration section with no options.
 */
export interface GoogleSearchProviderOptions {
	/**
	 * The configuration section (defaults to the schema's defaults). A thunk
	 * rather than a value when the section can change at runtime (the plugin
	 * entry passes the settings-section source): the provider re-reads it for
	 * every operation, so a settings change takes effect without rebuilding
	 * the provider or re-registering it on the seam.
	 */
	readonly settings?: GoogleSearchSettings | (() => GoogleSearchSettings);
	/** Env source for the credential/engine-id fallbacks (defaults to `process.env`). */
	readonly env?: Record<string, string | undefined>;
	/** Plugin context supplying the credentials/launching-environment planes. */
	readonly ctx?: Context;
	/** HTTP transport for search calls (defaults to the global `fetch`). */
	readonly transport?: GoogleHttpTransport;
}

/**
 * Build the Google search provider.
 *
 * Configuration is resolved **per operation** (not eagerly at construction):
 * `available()` reports that a resolution path exists, and each `search()`
 * resolves the credential and engine id fresh, so a credential stored in the
 * Harness facilities or a settings change takes effect without rebuilding
 * the provider. When no path yields a value, `search()` fails with a
 * structured, actionable `MISSING_CREDENTIAL` error naming the missing
 * setting/environment variables (never their values). No secret is ever
 * cached, persisted, or included in an error message.
 */
export function buildGoogleSearchProvider(options: GoogleSearchProviderOptions = {}): WebSearchProvider {
	// The active configuration source: the resolved settings scope while one
	// is attached, the composition entry otherwise (the plugin entry passes
	// the settings-section source thunk; tests pass a plain section).
	const settingsSource = (): GoogleSearchSettings => {
		const s = options.settings;
		return typeof s === "function" ? s() : s ?? Config(undefined);
	};
	const env = options.env ?? process.env;
	const ctx = options.ctx;
	const transport = options.transport ?? defaultGoogleHttpTransport;

	const missingMessage = (missing: readonly string[]): string =>
		`google search provider is not configured: missing ${missing
			.map((name) =>
				name === GOOGLE_SEARCH_ENGINE_ID_ENV
					? `the engine id (setting "engineId" or environment variable ${name})`
					: `the API credential (setting "apiKey", or environment variable ${name})`
			)
			.join(" and ")} (set them at runtime; never commit the credential)`;

	return {
		id: GOOGLE_SEARCH_PROVIDER_ID,
		// Cheap, synchronous usability check, no network calls, no async
		// resolution (seam contract): a resolution PATH exists.
		available: () => googleSearchConfigPathExists(ctx, settingsSource(), env),
		async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
			// Snapshot the section once at the operation's entry so one search
			// never mixes two sections (the settings section can change
			// between searches).
			const settings = settingsSource();
			const apiKey = await resolveGoogleSearchCredential(ctx, settings, env);
			const cx = resolveGoogleSearchEngineId(settings, env);

			if (apiKey === undefined || cx === undefined) {
				const missing: string[] = [];
				if (apiKey === undefined) {
					missing.push(GOOGLE_SEARCH_API_KEY_ENV);
				}
				if (cx === undefined) {
					missing.push(GOOGLE_SEARCH_ENGINE_ID_ENV);
				}
				throw mapGoogleSearchFailure("missing_credential", missingMessage(missing));
			}

			// The caller's bound wins when given; otherwise the configured
			// default applies. Both are clamped to the API's 1..10 range.
			const maxResults = request.maxResults ?? settings.maxResults;
			const num = googleNumForMaxResults(maxResults);

			// Provider-level deadline (requestTimeoutMs) fused with the
			// caller's signal: the timeout aborts with a TimeoutReason, which
			// the transport classifies as TIMEOUT.
			const requestTimeoutMs = settings.requestTimeoutMs ?? 30_000;
			const d = deadline(signal, requestTimeoutMs, "GOOGLE_SEARCH_TIMEOUT");
			try {
				return await performGoogleSearch(
					{
						apiKey,
						cx,
						query: request.query,
						...(num !== undefined ? { num } : {}),
						...(settings.language !== undefined && settings.language.trim().length > 0
							? { language: settings.language }
							: {}),
						...(settings.region !== undefined && settings.region.trim().length > 0
							? { region: settings.region }
							: {}),
						// Google's default is "off"; sending it explicitly is
						// noise, so only the non-default "active" is sent.
						...(settings.safeSearch === "active" ? { safe: "active" as const } : {})
					},
					transport,
					d.signal
				);
			} finally {
				d[Symbol.dispose]();
			}
		}
	};
}
