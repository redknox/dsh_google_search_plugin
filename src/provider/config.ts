/**
 * Google search runtime configuration (Issue #4).
 *
 * Per ENGINEERING.md §4 and ARCHITECTURE.md ("Initial Google backend target
 * (MVP)"), the adapter's runtime configuration is:
 *
 *   - the Google **API credential** (secret, runtime-only), and
 *   - the **search engine id** (`cx`) — required by the Custom Search JSON
 *     API, identifying the Programmable Search Engine.
 *
 * Both are supplied at runtime via **environment variables** and are **never
 * committed** and never stored in ordinary settings. This module documents
 * the variable *names* (never a value) and resolves them from an injectable
 * env source so the provider stays testable without touching
 * `process.env`.
 *
 * A blank (empty or whitespace-only) value is treated as **absent** — the
 * same absent/blank discipline the normalization layer applies to optional
 * fields (ENGINEERING.md §2: no silent unknown → concrete value).
 */

/** The environment variable holding the Google API credential (secret). */
export const GOOGLE_SEARCH_API_KEY_ENV = "GOOGLE_SEARCH_API_KEY";

/** The environment variable holding the Programmable Search Engine id (`cx`). */
export const GOOGLE_SEARCH_ENGINE_ID_ENV = "GOOGLE_SEARCH_ENGINE_ID";

/** The resolved, usable Google search configuration. */
export interface GoogleSearchConfig {
	/** The Google API credential. Never logged, never committed. */
	readonly apiKey: string;
	/** The Programmable Search Engine id required by the Custom Search JSON API. */
	readonly cx: string;
}

/**
 * The outcome of resolving the runtime configuration: either a usable
 * {@link GoogleSearchConfig}, or the names of the environment variables that
 * are missing (or blank). The missing *names* are safe to surface in error
 * messages; the values are never surfaced.
 */
export interface GoogleSearchConfigResolution {
	readonly config?: GoogleSearchConfig;
	readonly missing: readonly string[];
}

/**
 * Resolve the Google search configuration from an env source.
 *
 * @param env - the env source to read (defaults to `process.env`); injectable
 *   so tests never depend on the real process environment.
 * @returns the resolved configuration when both values are present and
 *   non-blank, otherwise the list of missing variable names (never values).
 */
export function resolveGoogleSearchConfig(
	env: Record<string, string | undefined> = process.env
): GoogleSearchConfigResolution {
	const apiKey = asNonBlank(env[GOOGLE_SEARCH_API_KEY_ENV]);
	const cx = asNonBlank(env[GOOGLE_SEARCH_ENGINE_ID_ENV]);

	const missing: string[] = [];
	if (apiKey === undefined) {
		missing.push(GOOGLE_SEARCH_API_KEY_ENV);
	}
	if (cx === undefined) {
		missing.push(GOOGLE_SEARCH_ENGINE_ID_ENV);
	}

	if (missing.length > 0) {
		return { missing };
	}
	return { config: { apiKey: apiKey as string, cx: cx as string }, missing: [] };
}

/**
 * Read an env value, trimming surrounding whitespace; return `undefined` when
 * it is absent or blank (treated as absent, never defaulted).
 */
function asNonBlank(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
