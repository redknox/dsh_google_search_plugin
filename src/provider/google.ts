/**
 * The Google search provider for the `ctx.web` seam (Issues #2, #4, #6, #7).
 *
 * This plugin is **provider-only** (ARCHITECTURE.md): it registers a
 * `WebSearchProvider` on `ctx.web` (`@deepseek-ai/dsh-web`). The model-facing
 * `web_search` tool — its schema, rendering, and prompt guidance — is owned by
 * `@deepseek-ai/dsh-tool-web`; this plugin does not reimplement or shadow it.
 *
 * `search()` translates the seam's `WebSearchRequest` into a Gemini API
 * `google_search` grounding call (the provider edge, `./transport.ts`),
 * normalizes the response onto the seam's `WebSearchResult`
 * (`./normalize.ts`), and maps every failure path onto a structured
 * `WebError` (`./errors.ts`). Google's wire format stays inside this adapter
 * layer and never leaks into the seam (ENGINEERING.md §1).
 *
 * **Issue #7 migration.** The backend is the Gemini API `google_search`
 * grounding tool, not the Custom Search JSON API (retired by Google, closed
 * to new customers — see the transport module doc). The grounding API needs
 * only an API key: there is no engine id and no per-request result-count,
 * language, region, or SafeSearch control. The seam still enforces
 * `maxResults` on the way back; the result count is whatever the grounding
 * response returns.
 *
 * Configuration (Issue #6): the provider is built from the plugin's persisted
 * settings section (the {@link Settings} schema, see `./config.ts`) plus the
 * literal `apiKey` from the plugin composition input. **Credentials are
 * resolved per operation** — the literal composition key (a `role("secret")`
 * value that is never persisted), then the Harness credential facilities,
 * then the launching environment, then the process environment — and are
 * never cached on the provider or stored in ordinary settings
 * (ENGINEERING.md §4). Behavior settings (grounding model, request timeout)
 * come from the settings section and may be changed at runtime through the
 * `google-search` settings section without editing source. The settings
 * section has no `apiKey` field, so the credential can never be persisted
 * through it.
 *
 * `available()` is the cheap, **synchronous** check the seam contract
 * requires: it reports whether a *resolution path* exists for the credential
 * (a path, not a value) and makes **no network calls** and no asynchronous
 * resolution. When no path yields a value, `search()` fails with a
 * structured, actionable `MISSING_CREDENTIAL` error naming the missing
 * setting/environment variable (never its value) — the canonical DSH
 * credential pattern.
 *
 * Cancellation: the seam's `signal` is forwarded to the transport; an aborted
 * caller produces a structured `ABORTED` (or `TIMEOUT` when the abort reason
 * is a `TimeoutError`/`TimeoutReason`), never a hang and never a
 * success-shaped result. The `requestTimeoutMs` setting adds a provider-level
 * deadline (via `@deepseek-ai/dsh-timeout`'s `deadline()`) on top of the
 * caller's signal, so a hung Gemini request degrades to a stable `TIMEOUT`.
 */

import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from "@deepseek-ai/dsh-web";
import { deadline } from "@deepseek-ai/dsh-timeout";
import type { Context } from "@deepseek-ai/cordis";

import {
	GEMINI_API_KEY_ENV,
	Settings,
	googleSearchConfigPathExists,
	resolveGoogleSearchCredential,
	type GoogleSearchSettings
} from "./config.js";
import { mapGoogleSearchFailure } from "./errors.js";
import {
	defaultGeminiHttpTransport,
	performGeminiSearch,
	type GeminiHttpTransport
} from "./transport.js";

/** Stable provider id, unique within the search capability kind. */
export const GOOGLE_SEARCH_PROVIDER_ID = "google";

/**
 * Options for building the Google search provider.
 *
 * All fields are injectable for tests: `settings` is the persisted settings
 * section (defaults to the schema's defaults), `apiKey` is the literal
 * credential from the plugin composition input (a `role("secret")` value that
 * is never persisted), `env` is the env source the credential fallback is
 * resolved from (defaults to `process.env`), `ctx` is the plugin context
 * supplying the credential and environment planes (defaults to `undefined`
 * — the bare provider path), and `transport` is the HTTP transport used for
 * search calls (defaults to the runtime's global `fetch`).
 * Production code builds the provider from the plugin's settings section plus
 * the literal composition key.
 */
export interface GoogleSearchProviderOptions {
	/**
	 * The persisted settings section (defaults to the schema's defaults). A
	 * thunk rather than a value when the section can change at runtime (the
	 * plugin entry passes the settings-section source): the provider re-reads
	 * it for every operation, so a settings change takes effect without
	 * rebuilding the provider or re-registering it on the seam. This section
	 * never carries an `apiKey` (see `./config.ts`).
	 */
	readonly settings?: GoogleSearchSettings | (() => GoogleSearchSettings);
	/**
	 * The literal API credential from the plugin composition input, if any.
	 * A `role("secret")` value that is resolved per operation and is **never**
	 * part of the persisted settings, so it can never be written to the
	 * settings file. When absent, the credential is resolved from the
	 * `apiKeyEnv` reference through the credential/environment planes.
	 */
	readonly apiKey?: string;
	/** Env source for the credential fallback (defaults to `process.env`). */
	readonly env?: Record<string, string | undefined>;
	/** Plugin context supplying the credentials/launching-environment planes. */
	readonly ctx?: Context;
	/** HTTP transport for search calls (defaults to the global `fetch`). */
	readonly transport?: GeminiHttpTransport;
}

/**
 * Build the Google search provider.
 *
 * Configuration is resolved **per operation** (not eagerly at construction):
 * `available()` reports that a resolution path exists, and each `search()`
 * resolves the credential fresh, so a credential stored in the Harness
 * facilities or a settings change takes effect without rebuilding the
 * provider. When no path yields a value, `search()` fails with a structured,
 * actionable `MISSING_CREDENTIAL` error naming the missing setting/environment
 * variable (never its value). No secret is ever cached, persisted, or
 * included in an error message.
 */
export function buildGoogleSearchProvider(options: GoogleSearchProviderOptions = {}): WebSearchProvider {
	// The active configuration source: the resolved settings scope while one
	// is attached, the composition entry otherwise (the plugin entry passes
	// the settings-section source thunk; tests pass a plain section).
	const settingsSource = (): GoogleSearchSettings => {
		const s = options.settings;
		return typeof s === "function" ? s() : s ?? Settings(undefined);
	};
	// The literal credential from the plugin composition input (a
	// role("secret") value that is never persisted). Resolved per operation,
	// ahead of the apiKeyEnv reference planes.
	const literalApiKey = options.apiKey;
	const env = options.env ?? process.env;
	const ctx = options.ctx;
	const transport = options.transport ?? defaultGeminiHttpTransport;

	const missingMessage = (missing: readonly string[]): string =>
		`google search provider is not configured: missing ${missing
			.map(
				(name) =>
					`the API credential (set the ${name} environment variable, or store the credential under the "apiKeyEnv" name in the Harness credential facilities)`
			)
			.join(" and ")} (set them at runtime; never commit the credential)`;

	return {
		id: GOOGLE_SEARCH_PROVIDER_ID,
		// Cheap, synchronous usability check, no network calls, no async
		// resolution (seam contract): a resolution PATH exists.
		available: () => googleSearchConfigPathExists(ctx, settingsSource(), literalApiKey, env),
		async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
			// Snapshot the section once at the operation's entry so one search
			// never mixes two sections (the settings section can change
			// between searches).
			const settings = settingsSource();
			const apiKey = await resolveGoogleSearchCredential(ctx, settings, literalApiKey, env);

			if (apiKey === undefined) {
				throw mapGoogleSearchFailure("missing_credential", missingMessage([GEMINI_API_KEY_ENV]));
			}

			// Provider-level deadline (requestTimeoutMs) fused with the
			// caller's signal: the timeout aborts with a TimeoutReason, which
			// the transport classifies as TIMEOUT.
			const requestTimeoutMs = settings.requestTimeoutMs ?? 30_000;
			const d = deadline(signal, requestTimeoutMs, "GOOGLE_SEARCH_TIMEOUT");
			try {
				return await performGeminiSearch(
					{
						apiKey,
						model: settings.model,
						query: request.query,
						// Clamps the inline citation markers to the sources the
						// seam will keep (the seam performs the truncation).
						...(request.maxResults !== undefined ? { maxResults: request.maxResults } : {})
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
