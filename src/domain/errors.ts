/**
 * Stable, machine-routable search error categories (Issue #3).
 *
 * Per ENGINEERING.md §7, failures are structured errors carrying a stable
 * `code` — never thrown strings or swallowed exceptions — and a failure is
 * never hidden behind a success-shaped result. The codes are the routing
 * surface: consumers switch on `code`, not on message text.
 *
 * The categories are provider-neutral: they describe *what kind* of failure
 * occurred, not which provider produced it. Provider-specific status codes
 * and wire errors are mapped onto these categories inside the adapter
 * (Issue #4).
 */

/** The closed set of search error categories. */
export const SEARCH_ERROR_CODES = [
	/**
	 * The request failed domain validation (for example an empty query or a
	 * non-positive `limit`). The request never reaches a provider.
	 */
	"invalid_request",
	/**
	 * Authentication or configuration failure: a required credential or
	 * configuration value is missing, invalid, or rejected by the provider.
	 */
	"auth_failure",
	/**
	 * Capability unavailable: no usable search provider is registered or
	 * available for this deployment. Distinct from a request failure — the
	 * provider was never reached (ENGINEERING.md §7).
	 */
	"capability_unavailable",
	/** The provider reported a rate limit or quota exhaustion. */
	"rate_limited",
	/**
	 * The operation timed out or was cancelled. The category deliberately
	 * groups timeout and cancellation: both end the operation without a
	 * provider answer, and a router treats them the same way.
	 */
	"timeout_or_cancellation",
	/**
	 * The provider was reached and returned an error that is not a rate
	 * limit, an auth failure, or a malformed response.
	 */
	"provider_failure",
	/**
	 * The provider response could not be parsed or mapped onto the
	 * provider-neutral result shape.
	 */
	"malformed_response"
] as const;

/** One stable, machine-routable error category. */
export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

/**
 * A structured search failure. `code` is the stable category; `message` is
 * human-readable detail; `cause` optionally carries the underlying error
 * (for example a transport failure) without leaking its shape into the
 * category.
 */
export class SearchError extends Error {
	readonly code: SearchErrorCode;
	readonly cause?: unknown;

	constructor(code: SearchErrorCode, message: string, cause?: unknown) {
		super(message, cause !== undefined ? { cause } : undefined);
		this.name = "SearchError";
		this.code = code;
		if (cause !== undefined) this.cause = cause;
	}
}

/** Type guard: true when `value` is a {@link SearchError}. */
export function isSearchError(value: unknown): value is SearchError {
	return value instanceof SearchError;
}
