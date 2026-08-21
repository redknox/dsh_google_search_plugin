/**
 * Google search failure → `WebError` mapping (Issue #3).
 *
 * The plugin is provider-only (ARCHITECTURE.md): the stable, provider-neutral
 * error type is `WebError` from `@deepseek-ai/dsh-web`, whose `code` is
 * deliberately an **open string** so consumers can tolerate provider-specific
 * codes. This module does **not** define a closed error taxonomy and does
 * **not** introduce a parallel error class. It defines the *specific*
 * machine-routable codes the Google search adapter emits (a subset of the
 * open code space) and maps the failure classes the issue requires onto
 * `WebError` with those codes.
 *
 * Where the DSH harness already publishes a shared code for the same failure
 * class (rate limit, quota, timeout, abort, invalid credential), this module
 * reuses that exact string rather than inventing a synonym — so a router that
 * already understands the harness taxonomy can route Google failures without
 * a Google-specific branch.
 *
 * Per ENGINEERING.md §7, a failure is never hidden behind a success-shaped
 * result, and *capability unavailable* is kept distinct from *request failed*.
 */

import { WebError } from "@deepseek-ai/dsh-web";

/**
 * The machine-routable codes the Google search adapter emits. These are a
 * *subset* of the open `WebError.code` space, not a closed set: other
 * providers or a future re-pointed adapter may emit other codes, and
 * consumers MUST tolerate codes they do not recognize (the open-string
 * contract). Values that coincide with the DSH shared taxonomy are reused
 * verbatim.
 */
export const GOOGLE_SEARCH_ERROR_CODES = {
	/**
	 * The request was rejected as invalid before/without a provider round-trip
	 * (for example a malformed query). Distinct from a provider failure — the
	 * request was not (fully) processed.
	 */
	INVALID_REQUEST: "INVALID_REQUEST",
	/**
	 * Authentication/configuration failure: a required credential or
	 * configuration value (the Google API credential, or the search engine id
	 * where the product requires one) is missing. The provider was not reached
	 * with usable configuration.
	 */
	MISSING_CREDENTIAL: "MISSING_CREDENTIAL",
	/**
	 * Authentication/configuration failure: a supplied credential or
	 * configuration value was present but rejected by the provider (malformed
	 * or unauthorized). Reuses the DSH shared code verbatim.
	 */
	INVALID_CREDENTIAL: "INVALID_CREDENTIAL",
	/** The provider reported a rate limit. Reuses the DSH shared code verbatim. */
	RATE_LIMIT: "RATE_LIMIT",
	/** The provider reported an exhausted quota. Reuses the DSH shared code verbatim. */
	QUOTA: "QUOTA",
	/**
	 * The operation timed out. Reuses the DSH shared code verbatim. Distinct
	 * from cancellation: the operation was allowed to run and expired.
	 */
	TIMEOUT: "TIMEOUT",
	/**
	 * The operation was cancelled by the caller (the forwarded `signal`
	 * aborted). Reuses the DSH shared code verbatim.
	 */
	ABORTED: "ABORTED",
	/**
	 * The provider was reached and returned an error that is not a rate limit,
	 * quota, auth, or malformed-response failure (for example a 5xx).
	 */
	PROVIDER_FAILURE: "PROVIDER_FAILURE",
	/**
	 * The provider response could not be parsed or mapped onto the DSH seam
	 * result shape. Distinct from a provider failure — the request succeeded
	 * at the transport level but the body was unusable.
	 */
	MALFORMED_RESPONSE: "MALFORMED_RESPONSE"
} as const;

/** One machine-routable code the Google search adapter may emit. */
export type GoogleSearchErrorCode =
	(typeof GOOGLE_SEARCH_ERROR_CODES)[keyof typeof GOOGLE_SEARCH_ERROR_CODES];

/**
 * The failure classes the Google search adapter distinguishes. This is the
 * *input* classification (what the adapter observed), not the emitted code:
 * `mapGoogleSearchFailure` translates a class into a `WebError`.
 */
export type GoogleSearchFailureClass =
	| "invalid_request"
	| "missing_credential"
	| "invalid_credential"
	| "rate_limit"
	| "quota"
	| "timeout"
	| "aborted"
	| "provider_failure"
	| "malformed_response";

/** The fixed class → code mapping. */
const FAILURE_CLASS_TO_CODE: Record<GoogleSearchFailureClass, GoogleSearchErrorCode> = {
	invalid_request: GOOGLE_SEARCH_ERROR_CODES.INVALID_REQUEST,
	missing_credential: GOOGLE_SEARCH_ERROR_CODES.MISSING_CREDENTIAL,
	invalid_credential: GOOGLE_SEARCH_ERROR_CODES.INVALID_CREDENTIAL,
	rate_limit: GOOGLE_SEARCH_ERROR_CODES.RATE_LIMIT,
	quota: GOOGLE_SEARCH_ERROR_CODES.QUOTA,
	timeout: GOOGLE_SEARCH_ERROR_CODES.TIMEOUT,
	aborted: GOOGLE_SEARCH_ERROR_CODES.ABORTED,
	provider_failure: GOOGLE_SEARCH_ERROR_CODES.PROVIDER_FAILURE,
	malformed_response: GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE
};

/**
 * Map a classified Google search failure into a structured {@link WebError}.
 *
 * @param failureClass - the failure class the adapter observed.
 * @param message - human-readable detail (never includes a secret or `cx` value).
 * @param cause - optional underlying error (for example a transport failure),
 *   chained via `Error.cause` without leaking its shape into the code.
 * @returns a `WebError` whose `code` is the machine-routable code for the class.
 */
export function mapGoogleSearchFailure(
	failureClass: GoogleSearchFailureClass,
	message: string,
	cause?: unknown
): WebError {
	const code = FAILURE_CLASS_TO_CODE[failureClass];
	return new WebError(message, code, cause !== undefined ? { cause } : undefined);
}
