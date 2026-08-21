/**
 * Google Custom Search transport (Issue #4) — the provider edge.
 *
 * This is a **Google-adapter-owned** module: it is the only place in the
 * plugin that knows the Google endpoint, its query parameters (`key`, `cx`,
 * `q`, `num`), and its HTTP error shape. Per ARCHITECTURE.md §3 the concrete
 * Google product/API is an adapter-layer choice; the endpoint and parameter
 * set live here and nowhere else, so re-pointing the adapter never touches
 * the seam or the domain.
 *
 * Documented request shape (Google Programmable Search — Custom Search JSON
 * API, v1):
 *
 *   GET https://customsearch.googleapis.com/customsearch/v1
 *       ?key=<API credential>
 *       &cx=<Programmable Search Engine id>
 *       &q=<query>
 *       [&num=<1..10>]
 *
 * The API key travels as a query parameter because the API authenticates
 * that way; it is therefore **never** included in any error message or log
 * produced by this module (messages carry only status, reason, and the
 * provider's own error text).
 *
 * Error classification is deterministic and status/reason-based — no
 * free-text heuristics (ENGINEERING.md §2):
 *
 *   - `reason: quotaExceeded | dailyLimitExceeded`        → quota
 *   - `reason: rateLimitExceeded | userRateLimitExceeded` → rate_limit
 *   - `reason: accessNotConfigured`                       → provider_failure
 *   - HTTP 401 / 403                                      → invalid_credential
 *   - HTTP 429                                            → rate_limit
 *   - HTTP 400 with the documented "API key not valid"
 *     error text                                          → invalid_credential
 *   - HTTP 400 (other)                                    → invalid_request
 *   - HTTP 5xx and any other non-2xx                      → provider_failure
 *
 * Transport-level failures (connection refused, DNS, TLS, …) are classified
 * by the caller from the thrown error and the forwarded signal: an aborted
 * caller signal is *aborted* (or *timeout* when the abort reason is a
 * `TimeoutError`), anything else is *provider_failure*.
 *
 * **Cause-chain credential safety.** Because the request URL carries the API
 * credential as a query parameter, the raw thrown transport error is never
 * chained as `WebError.cause`: a production transport (or a proxy in front
 * of it) may embed the full request URL in its error text, and the cause is
 * exactly what log serializers walk. Instead, a sanitized stand-in — the
 * failure's `name`/`code` plus a bounded message with URL tokens scrubbed —
 * is chained (see {@link sanitizeTransportCause}).
 */

import type { WebSearchResult } from "@deepseek-ai/dsh-web";
import { mapGoogleSearchFailure, type GoogleSearchFailureClass } from "./errors.js";
import { normalizeGoogleSearchResponse } from "./normalize.js";

/** The documented Custom Search JSON API v1 endpoint (adapter-layer choice). */
export const GOOGLE_SEARCH_ENDPOINT = "https://customsearch.googleapis.com/customsearch/v1";

/** The Custom Search JSON API returns at most 10 results per request. */
export const GOOGLE_SEARCH_MAX_RESULTS_PER_REQUEST = 10;

/**
 * Everything the adapter needs to issue one Google search. The credential
 * values are runtime-only (ENGINEERING.md §4) and never serialized anywhere
 * except the request URL itself.
 */
export interface GoogleSearchRequestOptions {
	/** The Google API credential (query parameter `key`). */
	readonly apiKey: string;
	/** The Programmable Search Engine id (query parameter `cx`). */
	readonly cx: string;
	/** The search query (query parameter `q`). */
	readonly query: string;
	/**
	 * Requested result count (query parameter `num`), clamped to the API's
	 * 1..10 range. Omitted = Google's default (10).
	 */
	readonly num?: number;
}

/**
 * Serialize one Google search into its request URL.
 *
 * Parameter order is fixed (`key`, `cx`, `q`, `num`) so the output is
 * deterministic and fixture-stable. Values are percent-encoded by
 * `URLSearchParams`; the query is sent as-is (Google interprets it).
 *
 * @throws {RangeError} when `num` is not an integer within 1..10 — a
 *   programming error, surfaced loudly rather than silently clamped.
 */
export function buildGoogleSearchUrl(options: GoogleSearchRequestOptions): string {
	const params = new URLSearchParams();
	params.set("key", options.apiKey);
	params.set("cx", options.cx);
	params.set("q", options.query);
	if (options.num !== undefined) {
		if (!Number.isInteger(options.num) || options.num < 1 || options.num > GOOGLE_SEARCH_MAX_RESULTS_PER_REQUEST) {
			throw new RangeError(
				`google search 'num' must be an integer between 1 and ${GOOGLE_SEARCH_MAX_RESULTS_PER_REQUEST}, got: ${String(options.num)}`
			);
		}
		params.set("num", String(options.num));
	}
	return `${GOOGLE_SEARCH_ENDPOINT}?${params.toString()}`;
}

/**
 * Map a `WebSearchRequest.maxResults` bound onto the API's `num` parameter:
 * the bound is applied at the request layer as a cost/latency optimization
 * (the seam still enforces it on the way back). Bounds above the API's 10
 * are clamped down; bounds below 1 are omitted (the seam truncates to them
 * regardless, so requesting is pointless).
 */
export function googleNumForMaxResults(maxResults: number | undefined): number | undefined {
	if (maxResults === undefined || !Number.isFinite(maxResults) || maxResults < 1) {
		return undefined;
	}
	return Math.min(Math.floor(maxResults), GOOGLE_SEARCH_MAX_RESULTS_PER_REQUEST);
}

/** One HTTP response from the Google endpoint, undecoded. */
export interface GoogleHttpResponse {
	/** The HTTP status code. */
	readonly status: number;
	/** The raw response body text (JSON for both success and error responses). */
	readonly body: string;
}

/**
 * A transport that performs one Google search request. The default
 * implementation uses the runtime's global `fetch`; tests inject a mock so
 * no network access or live credential is ever needed (ENGINEERING.md §8).
 *
 * @param url - the fully serialized request URL (includes the credential).
 * @param signal - the caller's cancellation signal, forwarded to the fetch.
 */
export type GoogleHttpTransport = (url: string, signal?: AbortSignal) => Promise<GoogleHttpResponse>;

/**
 * The default transport: the runtime's global `fetch`. Redirects are followed
 * (the endpoint does not redirect in practice); the body is returned as text
 * so the error classifier can inspect it.
 */
export const defaultGoogleHttpTransport: GoogleHttpTransport = async (url, signal) => {
	const response = await fetch(url, { method: "GET", signal: signal ?? null });
	const body = await response.text();
	return { status: response.status, body };
};

/** The parsed, optional fields of a Google error body. */
interface GoogleErrorDetail {
	/** The provider-declared failure reason (for example `quotaExceeded`). */
	reason?: string;
	/** The provider's own error message text. */
	message?: string;
}

/**
 * Parse a Google error body into its optional `reason` and `message`.
 *
 * The documented error shape is
 * `{ "error": { "code": <n>, "message": <string>, "status": <string>,
 * "errors": [ { "reason": <string>, "message": <string> } ] } }`.
 * Parsing is defensive: a body that is not JSON, or that lacks the expected
 * fields, yields no detail — classification then falls back to the status
 * code alone. Never throws.
 */
export function parseGoogleErrorDetail(body: string): GoogleErrorDetail {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {};
	}
	const error = (parsed as Record<string, unknown>)["error"];
	if (typeof error !== "object" || error === null || Array.isArray(error)) {
		return {};
	}
	const errorObj = error as Record<string, unknown>;
	const detail: GoogleErrorDetail = {};
	const message = errorObj["message"];
	if (typeof message === "string" && message.trim().length > 0) {
		detail.message = message.trim();
	}
	const errors = errorObj["errors"];
	if (Array.isArray(errors)) {
		for (const entry of errors) {
			if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
				const reason = (entry as Record<string, unknown>)["reason"];
				if (typeof reason === "string" && reason.trim().length > 0) {
					detail.reason = reason.trim();
					break;
				}
			}
		}
	}
	return detail;
}

/**
 * Classify a non-2xx Google response into a failure class (see the module
 * doc for the deterministic rules). The body is inspected only for the
 * documented `reason`/`message` fields; classification never depends on
 * parsing free text beyond the documented "API key not valid" error.
 */
export function classifyGoogleHttpError(status: number, body: string): GoogleSearchFailureClass {
	const { reason, message } = parseGoogleErrorDetail(body);

	// Provider-declared reasons are the most specific signal.
	switch (reason) {
		case "quotaExceeded":
		case "dailyLimitExceeded":
			return "quota";
		case "rateLimitExceeded":
		case "userRateLimitExceeded":
			return "rate_limit";
		case "accessNotConfigured":
			return "provider_failure";
		default:
			break;
	}

	// Status-based classification.
	if (status === 401 || status === 403) {
		return "invalid_credential";
	}
	if (status === 429) {
		return "rate_limit";
	}
	if (status === 400) {
		// The documented error for an invalid API key is a 400 whose message
		// states the key is not valid — an authentication failure, not a
		// malformed request. The match is against that documented text only.
		if (message !== undefined && /api key not valid/i.test(message)) {
			return "invalid_credential";
		}
		return "invalid_request";
	}
	if (status >= 500) {
		return "provider_failure";
	}
	return "provider_failure";
}

/**
 * Build the human-readable message for a non-2xx Google response. Carries the
 * status, the provider's reason/message when present, and never the request
 * URL (which contains the credential) or the raw body.
 */
export function describeGoogleHttpError(status: number, body: string): string {
	const { reason, message } = parseGoogleErrorDetail(body);
	let text = `google search request failed with HTTP ${status}`;
	if (reason !== undefined) {
		text += ` (reason: ${reason})`;
	}
	if (message !== undefined) {
		text += `: ${truncate(message, 300)}`;
	}
	return text;
}

/**
 * Classify a transport-level failure (the fetch itself threw) given the
 * caller's signal: an aborted signal means the caller cancelled — *timeout*
 * when the abort reason is a `TimeoutError` (as produced by
 * `AbortSignal.timeout`), *aborted* otherwise. A non-aborted failure is a
 * *timeout* when the thrown error is a `TimeoutError`, an *aborted* when it
 * is an `AbortError`, and a *provider_failure* for everything else
 * (connection refused, DNS, TLS, …).
 */
export function classifyGoogleFetchError(err: unknown, signal: AbortSignal | undefined): GoogleSearchFailureClass {
	if (signal?.aborted) {
		return nameOf(signal.reason) === "TimeoutError" ? "timeout" : "aborted";
	}
	const name = nameOf(err);
	if (name === "TimeoutError") {
		return "timeout";
	}
	if (name === "AbortError") {
		return "aborted";
	}
	return "provider_failure";
}

/**
 * Perform one Google search end to end: resolve configuration, serialize the
 * request, perform the transport call, classify failures, and normalize a
 * successful response onto the seam result shape.
 *
 * Every failure path throws a structured {@link WebError} (via
 * {@link mapGoogleSearchFailure}) — never a success-shaped result
 * (ENGINEERING.md §7):
 *
 *   - missing configuration        → `MISSING_CREDENTIAL`
 *   - transport throw              → `ABORTED` / `TIMEOUT` / `PROVIDER_FAILURE`
 *   - non-2xx response             → per {@link classifyGoogleHttpError}
 *   - unparseable / unmappable 2xx → `MALFORMED_RESPONSE`
 *
 * @param options - credential + query + optional `num` (see above).
 * @param transport - the HTTP transport (injectable for tests).
 * @param signal - the caller's cancellation signal, forwarded to the transport.
 */
export async function performGoogleSearch(
	options: GoogleSearchRequestOptions,
	transport: GoogleHttpTransport,
	signal?: AbortSignal
): Promise<WebSearchResult> {
	const url = buildGoogleSearchUrl(options);

	let response: GoogleHttpResponse;
	try {
		response = await transport(url, signal);
	} catch (err) {
		const failureClass = classifyGoogleFetchError(err, signal);
		const message =
			failureClass === "aborted"
				? "google search request was cancelled"
				: failureClass === "timeout"
					? "google search request timed out"
					: `google search request failed: ${describeThrownError(err)}`;
		// Chain the credential-safe stand-in, never the raw transport error
		// (see the module doc — the request URL carries the credential).
		throw mapGoogleSearchFailure(failureClass, message, sanitizeTransportCause(err));
	}

	if (response.status < 200 || response.status >= 300) {
		throw mapGoogleSearchFailure(
			classifyGoogleHttpError(response.status, response.body),
			describeGoogleHttpError(response.status, response.body)
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(response.body);
	} catch (err) {
		throw mapGoogleSearchFailure("malformed_response", "google search response is not valid JSON", err);
	}
	// Throws WebError(MALFORMED_RESPONSE) when the body cannot be mapped onto
	// the seam shape (see normalize.ts for the rules).
	return normalizeGoogleSearchResponse(parsed);
}

/**
 * Build the credential-safe stand-in chained as `WebError.cause` for a
 * transport-level failure.
 *
 * The raw thrown error is deliberately **not** chained: the request URL
 * carries the API credential as a query parameter, and a production
 * transport (or a proxy in front of it) may embed the full request URL in
 * its error text — the cause is exactly what log serializers walk. The
 * stand-in preserves only what is safe and useful for diagnosis:
 *
 *   - the failure's `name` (for example `TimeoutError`, `AbortError`) and
 *     its `code` (for example `ECONNREFUSED`, `ENOTFOUND`);
 *   - a bounded, single-line `message` with URL tokens scrubbed: any
 *     `http(s)://…` token and any `key=…`/`cx=…` query fragment is replaced
 *     by a redaction marker, so a URL embedded in the message cannot
 *     survive into the cause chain.
 *
 * The stand-in is a plain `Error` (no custom class), so consumers that
 * inspect `cause` see a standard error shape.
 */
export function sanitizeTransportCause(err: unknown): Error {
	const name = nameOf(err) ?? "Error";
	const raw = err instanceof Error ? err.message : String(err);
	const cause = new Error(truncate(scrubUrlTokens(raw.replace(/\s+/g, " ").trim()), 300) || "transport error");
	cause.name = name;
	if (typeof err === "object" && err !== null) {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string" && code.length > 0) {
			(cause as { code?: string }).code = code;
		}
	}
	return cause;
}

/**
 * Scrub URL tokens from text: replace any `http(s)://…` token (up to the
 * first whitespace or quote) and any `key=…` / `cx=…` query fragment with a
 * redaction marker, so a credential-bearing URL cannot survive into an
 * error message or a cause chain.
 */
export function scrubUrlTokens(text: string): string {
	return text
		.replace(/https?:\/\/[^\s"'<>]+/gi, "[url redacted]")
		.replace(/\bkey=[^\s&"'<>]+/gi, "key=[redacted]")
		.replace(/\bcx=[^\s&"'<>]+/gi, "cx=[redacted]");
}

/** The `name` of a thrown value, when it carries one. */
function nameOf(value: unknown): string | undefined {
	if (typeof value === "object" && value !== null) {
		const name = (value as { name?: unknown }).name;
		if (typeof name === "string") {
			return name;
		}
	}
	return undefined;
}

/** A bounded, single-line, credential-safe description of a thrown transport error. */
function describeThrownError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return truncate(scrubUrlTokens(message.replace(/\s+/g, " ").trim()), 300) || "unknown transport error";
}

/** Truncate text to `max` characters, marking the cut. */
function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
