/**
 * Gemini `google_search` grounding transport (Issue #7 migration) — the
 * provider edge.
 *
 * This is a **Google-adapter-owned** module: it is the only place in the
 * plugin that knows the Gemini endpoint, its request shape, and its HTTP
 * error shape. Per ARCHITECTURE.md §3 the concrete Google product/API is an
 * adapter-layer choice; the endpoint and request shape live here and nowhere
 * else, so re-pointing the adapter never touches the seam or the domain.
 *
 * **Why Gemini grounding and not the Custom Search JSON API** (Issue #7):
 * the Custom Search JSON API (the previous backend) is being retired by
 * Google — announced January 2026, retirement 2027-01-01, and already closed
 * to new customers — so it is not a viable long-term target. The plugin's
 * backend is therefore the **Gemini API `google_search` grounding tool**:
 * one API key (no engine id, no separate billing project), and the response
 * carries both a synthesized answer and the grounding sources.
 *
 * Documented request shape (Gemini API, v1beta, `google_search` tool):
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   headers:
 *     x-goog-api-key: <API credential>
 *     Content-Type: application/json
 *   body:
 *     {
 *       "contents": [{ "role": "user", "parts": [{ "text": <prompt> }] }],
 *       "tools": [{ "google_search": {} }]
 *     }
 *
 * The prompt wraps the caller's query in a fixed instruction (see
 * {@link buildGeminiSearchPrompt}) so the model performs a web search and
 * answers from the results. The API key travels in the **request header**,
 * never in the URL: the serialized request URL contains only the model name,
 * and no error message or log produced by this module ever carries the key.
 *
 * Error classification is deterministic and status/reason-based — no
 * free-text heuristics (ENGINEERING.md §2):
 *
 *   - `reason: QUOTA_EXCEEDED`              → quota
 *   - `reason: RESOURCE_EXHAUSTED`          → rate_limit
 *   - HTTP 429                              → rate_limit
 *   - HTTP 400 with the documented "API key not valid"
 *     error text                            → invalid_credential
 *   - HTTP 401 / 403 (incl. the
 *     `API_KEY_SERVICE_BLOCKED` reason)     → invalid_credential
 *   - HTTP 400 (other)                      → invalid_request
 *   - HTTP 404 (model not available)        → provider_failure
 *   - HTTP 5xx and any other non-2xx        → provider_failure
 *
 * Transport-level failures (connection refused, DNS, TLS, …) are classified
 * by the caller from the thrown error and the forwarded signal: an aborted
 * caller signal is *aborted* (or *timeout* when the abort reason is a
 * `TimeoutError`), anything else is *provider_failure*.
 *
 * **Cause-chain credential safety.** The credential lives in a request
 * header, not the URL, but a production transport (or a proxy in front of
 * it) may still embed request details in its error text. The raw thrown
 * transport error is therefore never chained as `WebError.cause`: a
 * sanitized stand-in — the failure's `name`/`code` plus a bounded message
 * with URL tokens scrubbed — is chained instead (see
 * {@link sanitizeTransportCause}).
 */

import type { WebSearchResult } from "@deepseek-ai/dsh-web";
import { mapGoogleSearchFailure, type GoogleSearchFailureClass } from "./errors.js";
import { normalizeGeminiSearchResponse } from "./normalize.js";

/** The documented Gemini API v1beta base endpoint (adapter-layer choice). */
export const GEMINI_SEARCH_ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * The default grounding model. `gemini-3.6-flash` is the current flash model
 * Google recommends for new users (the API's own 404 message for retired
 * models points to it) and was verified live to perform `google_search`
 * grounding (Issue #7 E2E).
 */
export const GEMINI_SEARCH_DEFAULT_MODEL = "gemini-3.6-flash";

/** The request header carrying the API credential (never the URL). */
export const GEMINI_API_KEY_HEADER = "x-goog-api-key";

/**
 * The fixed instruction that wraps the caller's query. Verified live
 * (Issue #7) to make the model perform a web search and answer from the
 * results for both natural-language and keyword-style queries.
 */
export const GEMINI_SEARCH_PROMPT_TEMPLATE =
	"Search the web and answer the following query using the results, citing sources:\n\n";

/**
 * Everything the adapter needs to issue one Gemini grounding search. The
 * credential value is runtime-only (ENGINEERING.md §4) and is serialized
 * into the request **header** only — never the URL, never any error
 * message or log.
 */
export interface GeminiSearchRequestOptions {
	/** The Gemini API credential (request header `x-goog-api-key`). */
	readonly apiKey: string;
	/** The grounding model (path segment `{model}:generateContent`). */
	readonly model: string;
	/** The search query (wrapped by the prompt template in the request body). */
	readonly query: string;
}

/**
 * Build the model path for one grounding request. The model name is
 * validated by the settings schema (a conservative token pattern that
 * excludes `/` and `:`), so it cannot inject a path segment; this function
 * still rejects a blank value loudly rather than serialize a broken URL.
 */
export function buildGeminiSearchUrl(model: string): string {
	const trimmed = model.trim();
	if (trimmed.length === 0) {
		throw new RangeError("gemini search 'model' must be a non-blank model name");
	}
	if (trimmed.includes("/") || trimmed.includes(":")) {
		throw new RangeError(`gemini search 'model' must not contain '/' or ':', got: ${trimmed}`);
	}
	return `${GEMINI_SEARCH_ENDPOINT_BASE}/${trimmed}:generateContent`;
}

/** Build the fixed, deterministic prompt for one query. */
export function buildGeminiSearchPrompt(query: string): string {
	return `${GEMINI_SEARCH_PROMPT_TEMPLATE}${query}`;
}

/**
 * The fully serialized Gemini grounding request. The credential is in
 * `headers` (never in `url`); `body` is the JSON string sent as-is.
 */
export interface GeminiSearchHttpRequest {
	/** The request URL (model path only — no credential). */
	readonly url: string;
	/** The request headers (carries the credential in `x-goog-api-key`). */
	readonly headers: Record<string, string>;
	/** The JSON request body (prompt + `google_search` tool). */
	readonly body: string;
}

/**
 * Serialize one Gemini grounding search into its request. Key order in the
 * body is fixed (`contents`, then `tools`) so the output is deterministic
 * and fixture-stable.
 */
export function buildGeminiSearchRequest(options: GeminiSearchRequestOptions): GeminiSearchHttpRequest {
	const body: Record<string, unknown> = {
		contents: [{ role: "user", parts: [{ text: buildGeminiSearchPrompt(options.query) }] }],
		tools: [{ google_search: {} }]
	};
	return {
		url: buildGeminiSearchUrl(options.model),
		headers: {
			[GEMINI_API_KEY_HEADER]: options.apiKey,
			"Content-Type": "application/json"
		},
		body: JSON.stringify(body)
	};
}

/** One HTTP response from the Gemini endpoint, undecoded. */
export interface GeminiHttpResponse {
	/** The HTTP status code. */
	readonly status: number;
	/** The raw response body text (JSON for both success and error responses). */
	readonly body: string;
}

/**
 * A transport that performs one Gemini grounding request. The default
 * implementation uses the runtime's global `fetch`; tests inject a mock so
 * no network access or live credential is ever needed (ENGINEERING.md §8).
 *
 * @param request - the fully serialized request (credential in the header).
 * @param signal - the caller's cancellation signal, forwarded to the fetch.
 */
export type GeminiHttpTransport = (
	request: GeminiSearchHttpRequest,
	signal?: AbortSignal
) => Promise<GeminiHttpResponse>;

/**
 * The default transport: the runtime's global `fetch`. Redirects are
 * followed (the endpoint does not redirect in practice); the body is
 * returned as text so the error classifier can inspect it.
 */
export const defaultGeminiHttpTransport: GeminiHttpTransport = async (request, signal) => {
	const response = await fetch(request.url, {
		method: "POST",
		headers: request.headers,
		body: request.body,
		signal: signal ?? null
	});
	const body = await response.text();
	return { status: response.status, body };
};

/** The parsed, optional fields of a Gemini error body. */
interface GeminiErrorDetail {
	/** The provider-declared gRPC status (for example `PERMISSION_DENIED`). */
	status?: string;
	/** The first `ErrorInfo.reason` from `error.details` (for example `API_KEY_SERVICE_BLOCKED`). */
	reason?: string;
	/** The provider's own error message text. */
	message?: string;
}

/**
 * Parse a Gemini error body into its optional `status`, `reason`, and
 * `message`.
 *
 * The documented error shape is
 * `{ "error": { "code": <n>, "message": <string>, "status": <string>,
 * "details": [ { "@type": "type.googleapis.com/google.rpc.ErrorInfo",
 * "reason": <string>, "domain": <string> } ] } }`.
 * Parsing is defensive: a body that is not JSON, or that lacks the expected
 * fields, yields no detail — classification then falls back to the status
 * code alone. Never throws.
 */
export function parseGeminiErrorDetail(body: string): GeminiErrorDetail {
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
	const detail: GeminiErrorDetail = {};
	const message = errorObj["message"];
	if (typeof message === "string" && message.trim().length > 0) {
		detail.message = message.trim();
	}
	const status = errorObj["status"];
	if (typeof status === "string" && status.trim().length > 0) {
		detail.status = status.trim();
	}
	const details = errorObj["details"];
	if (Array.isArray(details)) {
		for (const entry of details) {
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
 * Classify a non-2xx Gemini response into a failure class (see the module
 * doc for the deterministic rules). The body is inspected only for the
 * documented `status`/`reason`/`message` fields; classification never
 * depends on parsing free text beyond the documented "API key not valid"
 * error.
 */
export function classifyGeminiHttpError(status: number, body: string): GoogleSearchFailureClass {
	const { reason, message } = parseGeminiErrorDetail(body);

	// Provider-declared reasons are the most specific signal.
	switch (reason) {
		case "QUOTA_EXCEEDED":
			return "quota";
		case "RESOURCE_EXHAUSTED":
			return "rate_limit";
		default:
			break;
	}

	// Status-based classification.
	if (status === 401 || status === 403) {
		// Covers PERMISSION_DENIED (incl. API_KEY_SERVICE_BLOCKED) and
		// UNAUTHENTICATED: the credential (or the account behind it) is
		// rejected.
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
	// 404 (a model that is not available to this key) and everything else:
	// the provider was reached and rejected the request for a reason that is
	// not a credential, rate-limit, or malformed-input failure.
	return "provider_failure";
}

/**
 * Build the human-readable message for a non-2xx Gemini response. Carries the
 * status, the provider's status/reason when present, and the provider's own
 * message — and never the request URL, the request header, or the raw body.
 */
export function describeGeminiHttpError(status: number, body: string): string {
	const { status: grpcStatus, reason, message } = parseGeminiErrorDetail(body);
	let text = `gemini search request failed with HTTP ${status}`;
	if (grpcStatus !== undefined) {
		text += ` (status: ${grpcStatus})`;
	}
	if (reason !== undefined) {
		text += `, reason: ${reason}`;
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
 * `AbortSignal.timeout`) or a `TimeoutReason` (as produced by the
 * `deadline()` helper in `@deepseek-ai/dsh-timeout`, which the provider uses
 * for its `requestTimeoutMs` setting), *aborted* otherwise. A non-aborted
 * failure is a *timeout* when the thrown error is a `TimeoutError` or
 * `TimeoutReason`, an *aborted* when it is an `AbortError`, and a
 * *provider_failure* for everything else (connection refused, DNS, TLS, …).
 */
export function classifyGeminiFetchError(err: unknown, signal: AbortSignal | undefined): GoogleSearchFailureClass {
	if (signal?.aborted) {
		return isTimeoutName(nameOf(signal.reason)) ? "timeout" : "aborted";
	}
	const name = nameOf(err);
	if (isTimeoutName(name)) {
		return "timeout";
	}
	if (name === "AbortError") {
		return "aborted";
	}
	return "provider_failure";
}

/** True for the abort-reason/error names that denote a timeout. */
function isTimeoutName(name: string | undefined): boolean {
	return name === "TimeoutError" || name === "TimeoutReason";
}

/**
 * Perform one Gemini grounding search end to end: serialize the request,
 * perform the transport call, classify failures, and normalize a successful
 * response onto the seam result shape.
 *
 * Every failure path throws a structured {@link WebError} (via
 * {@link mapGoogleSearchFailure}) — never a success-shaped result
 * (ENGINEERING.md §7):
 *
 *   - transport throw              → `ABORTED` / `TIMEOUT` / `PROVIDER_FAILURE`
 *   - non-2xx response             → per {@link classifyGeminiHttpError}
 *   - unparseable / unmappable 2xx → `MALFORMED_RESPONSE`
 *
 * (The `MISSING_CREDENTIAL` path is owned by the provider, which resolves
 * configuration per operation before calling this.)
 *
 * @param options - credential + model + query (see above).
 * @param transport - the HTTP transport (injectable for tests).
 * @param signal - the caller's cancellation signal, forwarded to the transport.
 */
export async function performGeminiSearch(
	options: GeminiSearchRequestOptions,
	transport: GeminiHttpTransport,
	signal?: AbortSignal
): Promise<WebSearchResult> {
	const request = buildGeminiSearchRequest(options);

	let response: GeminiHttpResponse;
	try {
		response = await transport(request, signal);
	} catch (err) {
		const failureClass = classifyGeminiFetchError(err, signal);
		const message =
			failureClass === "aborted"
				? "gemini search request was cancelled"
				: failureClass === "timeout"
					? "gemini search request timed out"
					: `gemini search request failed: ${describeThrownError(err)}`;
		// Chain the credential-safe stand-in, never the raw transport error
		// (see the module doc — a transport may embed request details).
		throw mapGoogleSearchFailure(failureClass, message, sanitizeTransportCause(err));
	}

	if (response.status < 200 || response.status >= 300) {
		throw mapGoogleSearchFailure(
			classifyGeminiHttpError(response.status, response.body),
			describeGeminiHttpError(response.status, response.body)
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(response.body);
	} catch (err) {
		throw mapGoogleSearchFailure("malformed_response", "gemini search response is not valid JSON", err);
	}
	// Throws WebError(MALFORMED_RESPONSE) when the body cannot be mapped onto
	// the seam shape (see normalize.ts for the rules).
	return normalizeGeminiSearchResponse(parsed);
}

/**
 * Build the credential-safe stand-in chained as `WebError.cause` for a
 * transport-level failure.
 *
 * The raw thrown error is deliberately **not** chained: a production
 * transport (or a proxy in front of it) may embed request details — URL or
 * header text — in its error message, and the cause is exactly what log
 * serializers walk. The stand-in preserves only what is safe and useful for
 * diagnosis:
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
 * error message or a cause chain. (Defense in depth: the adapter's own
 * requests carry the credential in a header, but a proxy's error text is
 * outside the adapter's control.)
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
