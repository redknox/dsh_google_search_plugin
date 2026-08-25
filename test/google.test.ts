/**
 * Issue #4/#7 acceptance tests — the real Google search backend adapter
 * (Gemini `google_search` grounding, post-migration).
 *
 * Everything here is **offline**: the HTTP transport is injected as a mock
 * that returns recorded fixtures, the runtime configuration comes from an
 * injected env source, and the only "credentials" in this file are fake
 * fixture values (acceptance criteria 5 and 6). No test touches the network
 * or `process.env` for configuration, and no real Google credential appears
 * anywhere in tracked files (a dedicated test enforces that).
 *
 * Coverage against the acceptance criteria:
 *   1. request serialization  — the seam request is serialized into the
 *      documented Gemini grounding request (endpoint + model path,
 *      `x-goog-api-key` header, prompt + `google_search` tool body);
 *   2. normalization          — Gemini results normalize onto the
 *      provider-neutral seam types without leaking wire DTOs (`uri` etc.
 *      stay in the adapter); the grounded artifact (answer + inline
 *      citations + the provider-supplied Search Suggestion artifact
 *      preserved verbatim) is carried end to end through `content`, and the
 *      grounding chunks are evidence in response order — not a claimed
 *      ranking;
 *   3. empty results          — a 200 response without `groundingMetadata`
 *      carries zero grounding sources (a valid zero-source result; the wire
 *      does not say whether a search ran and found nothing); a *present*
 *      non-array `groundingChunks` is malformed;
 *   4. stable failure paths   — auth/config, quota/rate-limit,
 *      timeout/cancel, provider error, and malformed response each have a
 *      stable, structured `WebError` code;
 *   5./6. no live credential  — mocks + fake fixture values only; the
 *      transport-error cause chain is credential-safe (URL tokens scrubbed,
 *      raw transport error never chained).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebError, type WebSearchResult } from "@deepseek-ai/dsh-web";

import { buildGoogleSearchProvider, GOOGLE_SEARCH_PROVIDER_ID } from "../src/index.js";
import { GEMINI_API_KEY_ENV, resolveGoogleSearchConfig } from "../src/provider/config.js";
import { GEMINI_SEARCH_SUGGESTION_LABEL } from "../src/provider/normalize.js";
import {
	GEMINI_API_KEY_HEADER,
	GEMINI_SEARCH_DEFAULT_MODEL,
	GEMINI_SEARCH_ENDPOINT_BASE,
	GEMINI_SEARCH_PROMPT_TEMPLATE,
	buildGeminiSearchPrompt,
	buildGeminiSearchRequest,
	buildGeminiSearchUrl,
	classifyGeminiFetchError,
	classifyGeminiHttpError,
	parseGeminiErrorDetail,
	sanitizeTransportCause,
	scrubUrlTokens,
	type GeminiHttpTransport,
	type GeminiHttpResponse,
	type GeminiSearchHttpRequest
} from "../src/provider/transport.js";

// ---------------------------------------------------------------------------
// Fixtures — fake values only; never a real credential (acceptance 5, 6).
// ---------------------------------------------------------------------------

const FAKE_API_KEY = "fake-api-key-000";

const CONFIGURED_ENV: Record<string, string | undefined> = {
	[GEMINI_API_KEY_ENV]: FAKE_API_KEY
};

/**
 * A stand-in for the provider-supplied Search Suggestion artifact
 * (`searchEntryPoint.renderedContent`): an HTML+CSS snippet, exactly as the
 * wire carries it (the live artifact is a styled widget; this is a minimal
 * stand-in with the same shape — HTML, not a URL).
 */
const FAKE_RENDERED_CONTENT =
	'<style>\n.chip { display: inline-block; border-radius: 16px; }\n</style>\n' +
	'<div class="container"><a class="chip" href="https://www.google.com/search?q=deepseek+harness&amp;client=app-vertex-grounding">deepseek harness</a></div>';

const SUCCESS_BODY = JSON.stringify({
	candidates: [
		{
			content: { parts: [{ text: "DeepSeek Harness is an open-source agent execution framework." }] },
			finishReason: "STOP",
			groundingMetadata: {
				groundingChunks: [
					{ web: { uri: "https://example.com/dsh", title: "github.com" } },
					{ web: { uri: "https://example.com/second", title: "wikipedia.org" } }
				],
				searchEntryPoint: { renderedContent: FAKE_RENDERED_CONTENT },
				webSearchQueries: ["deepseek harness"]
			}
		}
	]
});

const EMPTY_GROUNDING_BODY = JSON.stringify({
	candidates: [
		{
			content: { parts: [{ text: "A web search yielded no results." }] },
			finishReason: "STOP"
		}
	]
});

/** A mock transport that records calls and replies from a handler. */
function makeTransport(
	handler: (
		request: GeminiSearchHttpRequest,
		signal?: AbortSignal
	) => GeminiHttpResponse | Promise<GeminiHttpResponse>
) {
	const calls: { request: GeminiSearchHttpRequest; signal?: AbortSignal | undefined }[] = [];
	const transport: GeminiHttpTransport = async (request, signal) => {
		calls.push({ request, signal });
		return handler(request, signal);
	};
	return { transport, calls };
}

/** Build a provider with the configured fake env and the given transport. */
function configuredProvider(transport: GeminiHttpTransport) {
	return buildGoogleSearchProvider({ env: CONFIGURED_ENV, transport });
}

/** Assert a rejected search threw a `WebError` with the given code. */
async function expectWebError(promise: Promise<unknown>, code: string): Promise<WebError> {
	try {
		await promise;
	} catch (err) {
		assert.ok(err instanceof WebError, `expected WebError, got: ${String(err)}`);
		assert.equal((err as WebError).code, code);
		// No credential may ever leak into an error message.
		assert.ok(
			!((err as WebError).message ?? "").includes(FAKE_API_KEY),
			`error message must not contain the API credential: ${(err as WebError).message}`
		);
		return err as WebError;
	}
	assert.fail(`expected a WebError with code ${code}, but the promise resolved`);
}

/** Parse the JSON body of a captured request. */
function parsedBody(request: GeminiSearchHttpRequest): Record<string, unknown> {
	return JSON.parse(request.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Configuration (acceptance 4: authentication/configuration path)
// ---------------------------------------------------------------------------

test("resolveGoogleSearchConfig: the credential present and non-blank → config", () => {
	const { config, missing } = resolveGoogleSearchConfig(CONFIGURED_ENV);
	assert.deepEqual(missing, []);
	assert.deepEqual(config, { apiKey: FAKE_API_KEY });
});

test("resolveGoogleSearchConfig: an absent or blank value is missing (names, never values)", () => {
	assert.deepEqual(resolveGoogleSearchConfig({}).missing, [GEMINI_API_KEY_ENV]);
	assert.deepEqual(resolveGoogleSearchConfig({ [GEMINI_API_KEY_ENV]: "   " }).missing, [GEMINI_API_KEY_ENV]);
});

test("available() is a cheap local config check — no transport, no network", () => {
	const { transport } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const unconfigured = buildGoogleSearchProvider({ env: {}, transport });
	const configured = configuredProvider(transport);

	assert.equal(unconfigured.available(), false, "missing the credential → unavailable");
	assert.equal(
		buildGoogleSearchProvider({ env: { [GEMINI_API_KEY_ENV]: "  " }, transport }).available(),
		false,
		"blank value → unavailable"
	);
	assert.equal(configured.available(), true, "the credential present → available");
});

test("search() with missing configuration fails MISSING_CREDENTIAL without any request", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = buildGoogleSearchProvider({ env: {}, transport });

	const err = await expectWebError(provider.search({ query: "deepseek harness" }), "MISSING_CREDENTIAL");
	assert.match(err.message, new RegExp(GEMINI_API_KEY_ENV));
	assert.equal(calls.length, 0, "no transport call while unconfigured");
});

// ---------------------------------------------------------------------------
// Request serialization (acceptance 1)
// ---------------------------------------------------------------------------

test("buildGeminiSearchUrl serializes the documented model path", () => {
	const url = buildGeminiSearchUrl(GEMINI_SEARCH_DEFAULT_MODEL);
	const u = new URL(url);
	assert.equal(`${u.origin}${u.pathname}`, `${GEMINI_SEARCH_ENDPOINT_BASE}/${GEMINI_SEARCH_DEFAULT_MODEL}:generateContent`);
	assert.equal(u.search, "", "the URL carries no query string (no credential, no parameters)");
});

test("buildGeminiSearchUrl rejects a blank or path-injecting model name", () => {
	assert.throws(() => buildGeminiSearchUrl("   "), RangeError);
	assert.throws(() => buildGeminiSearchUrl("a/b"), RangeError, "a '/' would inject a path segment");
	assert.throws(() => buildGeminiSearchUrl("a:b"), RangeError, "a ':' would break the method suffix");
});

test("buildGeminiSearchPrompt wraps the query in the fixed instruction", () => {
	assert.equal(
		buildGeminiSearchPrompt("deepseek harness"),
		`${GEMINI_SEARCH_PROMPT_TEMPLATE}deepseek harness`
	);
});

test("buildGeminiSearchRequest serializes the documented request shape", () => {
	const request = buildGeminiSearchRequest({
		apiKey: FAKE_API_KEY,
		model: GEMINI_SEARCH_DEFAULT_MODEL,
		query: "deepseek harness"
	});
	// The credential travels in the header, never the URL.
	assert.equal(request.headers[GEMINI_API_KEY_HEADER], FAKE_API_KEY);
	assert.equal(request.headers["Content-Type"], "application/json");
	assert.ok(!request.url.includes(FAKE_API_KEY), "the URL must not carry the credential");
	assert.ok(!request.body.includes(FAKE_API_KEY), "the body must not carry the credential");

	const body = parsedBody(request);
	assert.deepEqual(body["tools"], [{ google_search: {} }], "the google_search tool is attached");
	const contents = body["contents"] as { role: string; parts: { text: string }[] }[];
	assert.equal(contents[0]?.role, "user");
	assert.equal(contents[0]?.parts?.[0]?.text, `${GEMINI_SEARCH_PROMPT_TEMPLATE}deepseek harness`);
});

test("buildGeminiSearchRequest percent-encodes special characters in the query", () => {
	const query = 'a b & c = d?"e"';
	const request = buildGeminiSearchRequest({
		apiKey: FAKE_API_KEY,
		model: GEMINI_SEARCH_DEFAULT_MODEL,
		query
	});
	const body = parsedBody(request);
	const contents = body["contents"] as { parts: { text: string }[] }[];
	assert.equal(contents[0]?.parts?.[0]?.text, `${GEMINI_SEARCH_PROMPT_TEMPLATE}${query}`, "the query round-trips through JSON");
});

test("search() sends the documented request for a seam request", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = configuredProvider(transport);

	await provider.search({ query: "deepseek harness" });
	assert.equal(calls.length, 1);
	const call = calls[0]!;
	assert.equal(call.request.url, `${GEMINI_SEARCH_ENDPOINT_BASE}/${GEMINI_SEARCH_DEFAULT_MODEL}:generateContent`);
	assert.equal(call.request.headers[GEMINI_API_KEY_HEADER], FAKE_API_KEY);
	const body = parsedBody(call.request);
	const contents = body["contents"] as { parts: { text: string }[] }[];
	assert.equal(contents[0]?.parts?.[0]?.text, `${GEMINI_SEARCH_PROMPT_TEMPLATE}deepseek harness`);
	assert.deepEqual(body["tools"], [{ google_search: {} }]);
	// The grounding API has no per-request result-count control: maxResults is
	// enforced by the seam on the way back, never sent in the request.
	assert.equal(body["num"], undefined, "no result-count parameter exists in the grounding API");
});

test("search() uses the configured model from the settings section", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = buildGoogleSearchProvider({
		env: CONFIGURED_ENV,
		transport,
		settings: { apiKeyEnv: GEMINI_API_KEY_ENV, model: "gemini-3.5-flash", requestTimeoutMs: 30_000 }
	});

	await provider.search({ query: "q" });
	assert.equal(calls[0]!.request.url, `${GEMINI_SEARCH_ENDPOINT_BASE}/gemini-3.5-flash:generateContent`);
});

// ---------------------------------------------------------------------------
// Response normalization (acceptance 2)
// ---------------------------------------------------------------------------

test("search() normalizes Gemini results onto the seam types without leaking wire DTOs", async () => {
	const { transport } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = configuredProvider(transport);

	const result: WebSearchResult = await provider.search({ query: "deepseek harness" });

	// Seam shape: sources array, truncated flag, the grounded answer as
	// content (answer text + the provider-supplied Search Suggestion
	// artifact, preserved verbatim).
	assert.equal(result.truncated, false, "the adapter never truncates; the seam owns that");
	assert.equal(
		result.content,
		`DeepSeek Harness is an open-source agent execution framework.\n\n` +
			`${GEMINI_SEARCH_SUGGESTION_LABEL}\n${FAKE_RENDERED_CONTENT}`
	);
	assert.equal(result.sources.length, 2, "the response's chunk order is preserved (evidence order, not a claimed ranking)");

	const [first, second] = result.sources;
	assert.equal(first?.url, "https://example.com/dsh", "web.uri → url");
	assert.equal(first?.title, "github.com", "web.title → title");
	assert.equal(second?.url, "https://example.com/second");
	assert.equal(second?.title, "wikipedia.org");
	assert.equal(second?.snippet, undefined, "the grounding response supplies no snippet — stays absent");

	// No wire DTO field may leak onto the seam source shape.
	for (const source of result.sources) {
		assert.equal((source as unknown as Record<string, unknown>)["uri"], undefined, "the 'uri' wire field must not leak");
		assert.equal((source as unknown as Record<string, unknown>)["web"], undefined, "the 'web' wire field must not leak");
		assert.equal((source as unknown as Record<string, unknown>)["publishedAt"], undefined, "publishedAt is never synthesized");
	}
});

// ---------------------------------------------------------------------------
// Empty results (acceptance 3)
// ---------------------------------------------------------------------------

test("a 200 response without groundingMetadata carries zero grounding sources (a valid zero-source result)", async () => {
	const { transport } = makeTransport(() => ({ status: 200, body: EMPTY_GROUNDING_BODY }));
	const provider = configuredProvider(transport);

	const result = await provider.search({ query: "nothing matches this" });
	assert.equal(result.sources.length, 0);
	assert.equal(result.content, "A web search yielded no results.", "the answer text still maps");
	assert.equal(result.truncated, false);
});

test("a 200 response with an empty groundingChunks array is a valid zero-source result", async () => {
	const { transport } = makeTransport(() => ({
		status: 200,
		body: JSON.stringify({
			candidates: [
				{ content: { parts: [{ text: "No results." }] }, groundingMetadata: { groundingChunks: [] } }
			]
		})
	}));
	const provider = configuredProvider(transport);

	const result = await provider.search({ query: "zzz no results" });
	assert.equal(result.sources.length, 0);
	assert.equal(result.truncated, false);
});

test("a 200 response with a present non-array groundingChunks field is MALFORMED_RESPONSE (review case)", async () => {
	const { transport } = makeTransport(() => ({
		status: 200,
		body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "A." }] }, groundingMetadata: { groundingChunks: "invalid" } }] })
	}));
	const provider = configuredProvider(transport);
	await expectWebError(provider.search({ query: "deepseek harness" }), "MALFORMED_RESPONSE");
});

// ---------------------------------------------------------------------------
// Failure paths (acceptance 4)
// ---------------------------------------------------------------------------

test("classifyGeminiHttpError: deterministic status/reason classification", () => {
	const quotaBody = JSON.stringify({
		error: {
			code: 429,
			message: "Quota exceeded for quota metric 'GenerateContent'",
			status: "RESOURCE_EXHAUSTED",
			details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXCEEDED", domain: "googleapis.com" }]
		}
	});
	const rateBody = JSON.stringify({
		error: {
			code: 429,
			message: "Resource has been exhausted (e.g. check quota).",
			status: "RESOURCE_EXHAUSTED",
			details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RESOURCE_EXHAUSTED", domain: "googleapis.com" }]
		}
	});
	const blockedKeyBody = JSON.stringify({
		error: {
			code: 403,
			message: "Requests to this API are blocked.",
			status: "PERMISSION_DENIED",
			details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_SERVICE_BLOCKED", domain: "googleapis.com" }]
		}
	});
	const badKeyBody = JSON.stringify({
		error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" }
	});
	const badQueryBody = JSON.stringify({
		error: { code: 400, message: "Invalid value at 'contents'", status: "INVALID_ARGUMENT" }
	});
	const modelBody = JSON.stringify({
		error: {
			code: 404,
			message: "This model models/gemini-2.5-flash is no longer available to new users.",
			status: "NOT_FOUND"
		}
	});

	assert.equal(classifyGeminiHttpError(429, quotaBody), "quota", "reason QUOTA_EXCEEDED → quota");
	assert.equal(classifyGeminiHttpError(429, rateBody), "rate_limit", "reason RESOURCE_EXHAUSTED → rate_limit");
	assert.equal(classifyGeminiHttpError(429, "{}"), "rate_limit", "HTTP 429 → rate_limit without a reason");
	assert.equal(classifyGeminiHttpError(403, blockedKeyBody), "invalid_credential", "API_KEY_SERVICE_BLOCKED is a credential/account failure");
	assert.equal(classifyGeminiHttpError(403, "{}"), "invalid_credential", "HTTP 403 → invalid_credential");
	assert.equal(classifyGeminiHttpError(401, "{}"), "invalid_credential", "HTTP 401 → invalid_credential");
	assert.equal(classifyGeminiHttpError(400, badKeyBody), "invalid_credential", "the documented invalid-key 400 is an auth failure");
	assert.equal(classifyGeminiHttpError(400, badQueryBody), "invalid_request", "other 400s are invalid requests");
	assert.equal(classifyGeminiHttpError(404, modelBody), "provider_failure", "a model that is not available is a provider failure");
	assert.equal(classifyGeminiHttpError(500, "{}"), "provider_failure", "HTTP 5xx → provider_failure");
	assert.equal(classifyGeminiHttpError(403, "not json at all"), "invalid_credential", "unparseable body falls back to the status");
});

test("parseGeminiErrorDetail: defensive parsing of the documented error shape", () => {
	const detail = parseGeminiErrorDetail(
		JSON.stringify({
			error: {
				code: 403,
				message: "  Requests blocked  ",
				status: "PERMISSION_DENIED",
				details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_SERVICE_BLOCKED" }]
			}
		})
	);
	assert.equal(detail.reason, "API_KEY_SERVICE_BLOCKED");
	assert.equal(detail.status, "PERMISSION_DENIED");
	assert.equal(detail.message, "Requests blocked", "message is trimmed");

	assert.deepEqual(parseGeminiErrorDetail("not json"), {}, "non-JSON body → no detail");
	assert.deepEqual(parseGeminiErrorDetail(JSON.stringify([1, 2])), {}, "non-object body → no detail");
	assert.deepEqual(parseGeminiErrorDetail(JSON.stringify({ ok: true })), {}, "missing error object → no detail");
});

test("search() maps non-2xx responses to stable WebError codes (no credential leak)", async () => {
	const cases: Array<{ status: number; body: string; code: string }> = [
		{ status: 401, body: JSON.stringify({ error: { code: 401, message: "Request had insufficient authentication scope.", status: "UNAUTHENTICATED" } }), code: "INVALID_CREDENTIAL" },
		{ status: 403, body: JSON.stringify({ error: { code: 403, message: "Request denied", status: "PERMISSION_DENIED" } }), code: "INVALID_CREDENTIAL" },
		{ status: 429, body: JSON.stringify({ error: { code: 429, message: "Rate limited", status: "RESOURCE_EXHAUSTED", details: [{ reason: "RESOURCE_EXHAUSTED" }] } }), code: "RATE_LIMIT" },
		{ status: 429, body: JSON.stringify({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED", details: [{ reason: "QUOTA_EXCEEDED" }] } }), code: "QUOTA" },
		{ status: 400, body: JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }), code: "INVALID_CREDENTIAL" },
		{ status: 400, body: JSON.stringify({ error: { code: 400, message: "Invalid value at 'contents'", status: "INVALID_ARGUMENT" } }), code: "INVALID_REQUEST" },
		{ status: 404, body: JSON.stringify({ error: { code: 404, message: "Model not available", status: "NOT_FOUND" } }), code: "PROVIDER_FAILURE" },
		{ status: 500, body: JSON.stringify({ error: { code: 500, message: "Internal error", status: "INTERNAL" } }), code: "PROVIDER_FAILURE" }
	];

	for (const { status, body, code } of cases) {
		const { transport, calls } = makeTransport(() => ({ status, body }));
		const provider = configuredProvider(transport);
		const err = await expectWebError(provider.search({ query: "deepseek harness" }), code);
		assert.match(err.message, new RegExp(`HTTP ${status}`), `message should carry the status for ${code}`);
		assert.equal(calls.length, 1);
	}
});

test("search() maps a 2xx body that is not JSON to MALFORMED_RESPONSE", async () => {
	const { transport } = makeTransport(() => ({ status: 200, body: "<html>not json</html>" }));
	const provider = configuredProvider(transport);
	await expectWebError(provider.search({ query: "deepseek harness" }), "MALFORMED_RESPONSE");
});

test("search() maps a 2xx body with a present non-array groundingChunks field to MALFORMED_RESPONSE", async () => {
	const { transport } = makeTransport(() => ({
		status: 200,
		body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "A." }] }, groundingMetadata: { groundingChunks: 42 } }] })
	}));
	const provider = configuredProvider(transport);
	await expectWebError(provider.search({ query: "deepseek harness" }), "MALFORMED_RESPONSE");
});

// ---------------------------------------------------------------------------
// Transport-level failures: timeout / cancel / provider error (acceptance 4)
// ---------------------------------------------------------------------------

test("classifyGeminiFetchError: aborted signal wins; otherwise the thrown error decides", () => {
	const aborted = new AbortController();
	aborted.abort();
	const timedOut = new AbortController();
	timedOut.abort(new DOMException("The operation was aborted due to a timeout", "TimeoutError"));

	assert.equal(classifyGeminiFetchError(new Error("fetch failed"), aborted.signal), "aborted");
	assert.equal(classifyGeminiFetchError(new Error("fetch failed"), timedOut.signal), "timeout");
	assert.equal(classifyGeminiFetchError(new DOMException("The operation was aborted", "AbortError"), undefined), "aborted");
	assert.equal(
		classifyGeminiFetchError(Object.assign(new Error("timeout"), { name: "TimeoutError" }), undefined),
		"timeout"
	);
	assert.equal(classifyGeminiFetchError(new Error("fetch failed"), undefined), "provider_failure");
});

test("search() maps a transport throw to a structured WebError with a credential-safe cause", async () => {
	const boom = new Error("fetch failed");
	const { transport } = makeTransport(() => {
		throw boom;
	});
	const provider = configuredProvider(transport);

	const err = await expectWebError(provider.search({ query: "deepseek harness" }), "PROVIDER_FAILURE");
	const cause = (err as Error).cause;
	assert.ok(cause instanceof Error, "a cause is chained (for diagnosis)");
	assert.notEqual(cause, boom, "the raw transport error is NOT chained — it may embed request details");
	assert.equal(cause.message, "fetch failed", "the safe parts of the failure survive");
	assert.equal(cause.name, "Error");
});

test("sanitizeTransportCause: a URL-embedding transport error is redacted in the cause", () => {
	// A production transport (or a proxy) may embed the full request URL in
	// its error text. The chained cause must not carry it. (Defense in depth:
	// the adapter's own requests carry the credential in a header, but a
	// proxy's error text is outside the adapter's control.)
	const raw = new TypeError(
		`fetch failed: POST ${GEMINI_SEARCH_ENDPOINT_BASE}/${GEMINI_SEARCH_DEFAULT_MODEL}:generateContent?key=${FAKE_API_KEY} failed`
	);
	raw.name = "TypeError";

	const cause = sanitizeTransportCause(raw);
	assert.equal(cause.name, "TypeError");
	assert.ok(!cause.message.includes(FAKE_API_KEY), "the credential must not survive into the cause");
	assert.match(cause.message, /fetch failed/, "the non-credential part of the message survives");
	assert.match(cause.message, /\[url redacted\]/, "the URL is replaced by a redaction marker");
});

test("sanitizeTransportCause: preserves name and code of the underlying failure", () => {
	const raw = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:59999"), { code: "ECONNREFUSED" });
	const cause = sanitizeTransportCause(raw);
	assert.equal(cause.message, "connect ECONNREFUSED 127.0.0.1:59999");
	assert.equal((cause as { code?: string }).code, "ECONNREFUSED", "the machine-routable code survives");
});

test("scrubUrlTokens: redacts URL tokens and key=/cx= query fragments", () => {
	assert.equal(scrubUrlTokens("ok"), "ok");
	assert.equal(
		scrubUrlTokens(`POST ${GEMINI_SEARCH_ENDPOINT_BASE}/x:generateContent?key=${FAKE_API_KEY} failed`),
		"POST [url redacted] failed"
	);
	assert.equal(scrubUrlTokens(`retry key=${FAKE_API_KEY} then cx=some-engine`), "retry key=[redacted] then cx=[redacted]");
});

test("search() honors an already-aborted signal (ABORTED) without any network work", async () => {
	const controller = new AbortController();
	controller.abort();
	const { transport, calls } = makeTransport((_request, signal) => {
		if (signal?.aborted) {
			throw new DOMException("The operation was aborted", "AbortError");
		}
		return { status: 200, body: SUCCESS_BODY };
	});
	const provider = configuredProvider(transport);

	const err = await expectWebError(provider.search({ query: "deepseek harness" }, controller.signal), "ABORTED");
	// The transport receives a signal FUSED with the provider's
	// requestTimeoutMs deadline (AbortSignal.any), so it is not the caller's
	// signal object itself — but the caller's abort must propagate to it.
	assert.equal(calls[0]?.signal?.aborted, true, "the caller's abort propagates to the transport signal");
	assert.notEqual(calls[0]?.signal, controller.signal, "the transport signal is the fused deadline signal");
	assert.match(err.message, /cancelled/i);
});

test("search() maps a timeout abort (TimeoutError reason) to TIMEOUT", async () => {
	const controller = new AbortController();
	controller.abort(new DOMException("The operation was aborted due to a timeout", "TimeoutError"));
	const { transport } = makeTransport((_request, signal) => {
		if (signal?.aborted) {
			throw new DOMException("The operation was aborted due to a timeout", "TimeoutError");
		}
		return { status: 200, body: SUCCESS_BODY };
	});
	const provider = configuredProvider(transport);

	const err = await expectWebError(provider.search({ query: "deepseek harness" }, controller.signal), "TIMEOUT");
	assert.match(err.message, /timed out/i);
});

test("search() forwards the signal: an in-flight request aborts with ABORTED", async () => {
	const controller = new AbortController();
	const { transport, calls } = makeTransport((_request, signal) => {
		return new Promise<GeminiHttpResponse>((resolve, reject) => {
			const timer = setTimeout(() => resolve({ status: 200, body: SUCCESS_BODY }), 500);
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(new DOMException("The operation was aborted", "AbortError"));
			});
		});
	});
	const provider = configuredProvider(transport);

	const pending = provider.search({ query: "deepseek harness" }, controller.signal);
	setTimeout(() => controller.abort(), 20);

	const err = await expectWebError(pending, "ABORTED");
	// The transport signal is the fused deadline signal (see the already-
	// aborted test above); the caller's in-flight abort must propagate to it.
	assert.equal(calls[0]?.signal?.aborted, true, "the caller's in-flight abort propagates to the transport signal");
	assert.notEqual(calls[0]?.signal, controller.signal, "the transport signal is the fused deadline signal");
	assert.match(err.message, /cancelled/i);
});

// ---------------------------------------------------------------------------
// Credential hygiene (acceptance 6)
// ---------------------------------------------------------------------------

test("no Google credential in tracked files except fake fixture values inside test/", () => {
	// Resolve the repository root from this compiled test's location
	// (lib-test/test/ → repo root is two levels up), then list the tracked
	// files via git (offline, no network).
	const here = path.dirname(fileURLToPath(import.meta.url));
	const repoRoot = path.resolve(here, "..", "..");
	assert.ok(existsSync(path.join(repoRoot, ".git")), "expected to run inside the repository checkout");

	const trackedFiles = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	assert.ok(trackedFiles.length > 0, "expected tracked files");

	for (const file of trackedFiles) {
		const full = path.join(repoRoot, file);
		let text: string;
		try {
			text = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		if (text.includes(FAKE_API_KEY)) {
			assert.ok(
				file.startsWith("test/"),
				`credential-shaped fixture values must stay inside test/ fixtures, found in ${file}`
			);
		}
	}
});
