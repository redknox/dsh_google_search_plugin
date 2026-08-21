/**
 * Issue #4 acceptance tests — the real Google search backend adapter.
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
 *      documented Custom Search JSON API request (endpoint, `key`, `cx`,
 *      `q`, `num`);
 *   2. normalization          — Google results normalize onto the provider-
 *      neutral seam types without leaking wire DTOs (`link` etc. stay in the
 *      adapter);
 *   3. empty results          — `items: []` is a valid zero-source result;
 *   4. stable failure paths   — auth/config, quota/rate-limit,
 *      timeout/cancel, provider error, and malformed response each have a
 *      stable, structured `WebError` code;
 *   5./6. no live credential  — mocks + fake fixture values only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebError, type WebSearchResult } from "@deepseek-ai/dsh-web";

import { buildGoogleSearchProvider, GOOGLE_SEARCH_PROVIDER_ID } from "../src/index.js";
import {
	GOOGLE_SEARCH_API_KEY_ENV,
	GOOGLE_SEARCH_ENGINE_ID_ENV,
	resolveGoogleSearchConfig
} from "../src/provider/config.js";
import {
	GOOGLE_SEARCH_ENDPOINT,
	GOOGLE_SEARCH_MAX_RESULTS_PER_REQUEST,
	buildGoogleSearchUrl,
	classifyGoogleFetchError,
	classifyGoogleHttpError,
	googleNumForMaxResults,
	parseGoogleErrorDetail,
	type GoogleHttpTransport,
	type GoogleHttpResponse
} from "../src/provider/transport.js";

// ---------------------------------------------------------------------------
// Fixtures — fake values only; never a real credential (acceptance 5, 6).
// ---------------------------------------------------------------------------

const FAKE_API_KEY = "fake-api-key-000";
const FAKE_CX = "fake-cx-000";

const CONFIGURED_ENV: Record<string, string | undefined> = {
	[GOOGLE_SEARCH_API_KEY_ENV]: FAKE_API_KEY,
	[GOOGLE_SEARCH_ENGINE_ID_ENV]: FAKE_CX
};

const SUCCESS_BODY = JSON.stringify({
	kind: "customsearch#search",
	queries: {
		request: [{ title: "Google Search", totalResults: "2", searchTerms: "deepseek harness" }]
	},
	items: [
		{
			kind: "customsearch#result",
			title: "DeepSeek Harness",
			link: "https://example.com/dsh",
			snippet: "The DeepSeek Harness."
		},
		{
			kind: "customsearch#result",
			title: "Second result",
			link: "https://example.com/second"
		}
	]
});

const EMPTY_ITEMS_BODY = JSON.stringify({
	kind: "customsearch#search",
	items: []
});

/** A mock transport that records calls and replies from a handler. */
function makeTransport(
	handler: (url: string, signal?: AbortSignal) => GoogleHttpResponse | Promise<GoogleHttpResponse>
) {
	const calls: { url: string; signal?: AbortSignal | undefined }[] = [];
	const transport: GoogleHttpTransport = async (url, signal) => {
		calls.push({ url, signal });
		return handler(url, signal);
	};
	return { transport, calls };
}

/** Build a provider with the configured fake env and the given transport. */
function configuredProvider(transport: GoogleHttpTransport) {
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

/** Parse a captured request URL into its origin+path and query parameters. */
function parsedUrl(url: string): { originPath: string; params: URLSearchParams } {
	const u = new URL(url);
	return { originPath: `${u.origin}${u.pathname}`, params: u.searchParams };
}

// ---------------------------------------------------------------------------
// Configuration (acceptance 4: authentication/configuration path)
// ---------------------------------------------------------------------------

test("resolveGoogleSearchConfig: both values present and non-blank → config", () => {
	const { config, missing } = resolveGoogleSearchConfig(CONFIGURED_ENV);
	assert.deepEqual(missing, []);
	assert.deepEqual(config, { apiKey: FAKE_API_KEY, cx: FAKE_CX });
});

test("resolveGoogleSearchConfig: absent or blank values are missing (names, never values)", () => {
	assert.deepEqual(resolveGoogleSearchConfig({}).missing, [GOOGLE_SEARCH_API_KEY_ENV, GOOGLE_SEARCH_ENGINE_ID_ENV]);
	assert.deepEqual(resolveGoogleSearchConfig({ [GOOGLE_SEARCH_API_KEY_ENV]: FAKE_API_KEY }).missing, [
		GOOGLE_SEARCH_ENGINE_ID_ENV
	]);
	assert.deepEqual(
		resolveGoogleSearchConfig({ [GOOGLE_SEARCH_API_KEY_ENV]: "   ", [GOOGLE_SEARCH_ENGINE_ID_ENV]: FAKE_CX }).missing,
		[GOOGLE_SEARCH_API_KEY_ENV]
	);
});

test("available() is a cheap local config check — no transport, no network", () => {
	const { transport } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const unconfigured = buildGoogleSearchProvider({ env: {}, transport });
	const configured = configuredProvider(transport);

	assert.equal(unconfigured.available(), false, "missing both values → unavailable");
	assert.equal(buildGoogleSearchProvider({ env: { [GOOGLE_SEARCH_API_KEY_ENV]: FAKE_API_KEY }, transport }).available(), false, "missing one value → unavailable");
	assert.equal(buildGoogleSearchProvider({ env: { [GOOGLE_SEARCH_API_KEY_ENV]: "  " }, transport }).available(), false, "blank value → unavailable");
	assert.equal(configured.available(), true, "both values present → available");
});

test("search() with missing configuration fails MISSING_CREDENTIAL without any request", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = buildGoogleSearchProvider({ env: {}, transport });

	const err = await expectWebError(
		provider.search({ query: "deepseek harness" }),
		"MISSING_CREDENTIAL"
	);
	assert.match(err.message, new RegExp(GOOGLE_SEARCH_API_KEY_ENV));
	assert.match(err.message, new RegExp(GOOGLE_SEARCH_ENGINE_ID_ENV));
	assert.equal(calls.length, 0, "no transport call while unconfigured");
});

// ---------------------------------------------------------------------------
// Request serialization (acceptance 1)
// ---------------------------------------------------------------------------

test("buildGoogleSearchUrl serializes the documented request shape", () => {
	const url = buildGoogleSearchUrl({ apiKey: FAKE_API_KEY, cx: FAKE_CX, query: "deepseek harness" });
	const { originPath, params } = parsedUrl(url);
	assert.equal(originPath, GOOGLE_SEARCH_ENDPOINT);
	assert.equal(params.get("key"), FAKE_API_KEY);
	assert.equal(params.get("cx"), FAKE_CX);
	assert.equal(params.get("q"), "deepseek harness");
	assert.equal(params.has("num"), false, "num is omitted when no bound is given");
});

test("buildGoogleSearchUrl percent-encodes special characters in the query", () => {
	const query = "a b & c = d?\"e\"";
	const url = buildGoogleSearchUrl({ apiKey: FAKE_API_KEY, cx: FAKE_CX, query });
	assert.equal(parsedUrl(url).params.get("q"), query, "the query round-trips through encoding");
});

test("buildGoogleSearchUrl rejects an out-of-range num (no silent clamp)", () => {
	assert.throws(
		() => buildGoogleSearchUrl({ apiKey: FAKE_API_KEY, cx: FAKE_CX, query: "q", num: 0 }),
		RangeError
	);
	assert.throws(
		() => buildGoogleSearchUrl({ apiKey: FAKE_API_KEY, cx: FAKE_CX, query: "q", num: 11 }),
		RangeError
	);
	assert.throws(
		() => buildGoogleSearchUrl({ apiKey: FAKE_API_KEY, cx: FAKE_CX, query: "q", num: 2.5 }),
		RangeError
	);
});

test("googleNumForMaxResults maps the seam bound onto the API's num (1..10)", () => {
	assert.equal(googleNumForMaxResults(undefined), undefined);
	assert.equal(googleNumForMaxResults(0), undefined, "a bound below 1 is omitted (the seam truncates anyway)");
	assert.equal(googleNumForMaxResults(5), 5);
	assert.equal(googleNumForMaxResults(10), 10);
	assert.equal(googleNumForMaxResults(50), GOOGLE_SEARCH_MAX_RESULTS_PER_REQUEST, "bounds above the API max clamp down");
	assert.equal(googleNumForMaxResults(3.7), 3, "fractional bounds floor to an integer");
});

test("search() sends the documented request for a seam request", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = configuredProvider(transport);

	await provider.search({ query: "deepseek harness" });
	assert.equal(calls.length, 1);
	const { originPath, params } = parsedUrl(calls[0]!.url);
	assert.equal(originPath, GOOGLE_SEARCH_ENDPOINT);
	assert.equal(params.get("key"), FAKE_API_KEY);
	assert.equal(params.get("cx"), FAKE_CX);
	assert.equal(params.get("q"), "deepseek harness");
	assert.equal(params.has("num"), false);
});

test("search() applies maxResults at the request layer as num (clamped to 1..10)", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = configuredProvider(transport);

	await provider.search({ query: "q", maxResults: 5 });
	assert.equal(parsedUrl(calls[0]!.url).params.get("num"), "5");

	await provider.search({ query: "q", maxResults: 50 });
	assert.equal(parsedUrl(calls[1]!.url).params.get("num"), "10");

	await provider.search({ query: "q", maxResults: 0 });
	assert.equal(parsedUrl(calls[2]!.url).params.has("num"), false);
});

// ---------------------------------------------------------------------------
// Response normalization (acceptance 2)
// ---------------------------------------------------------------------------

test("search() normalizes Google results onto the seam types without leaking wire DTOs", async () => {
	const { transport } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = configuredProvider(transport);

	const result: WebSearchResult = await provider.search({ query: "deepseek harness" });

	// Seam shape: sources array, truncated flag, no invented content.
	assert.equal(result.truncated, false, "the adapter never truncates; the seam owns that");
	assert.equal(result.content, undefined, "Google provides no aggregate content — never invented");
	assert.equal(result.sources.length, 2, "result order is preserved");

	const [first, second] = result.sources;
	assert.equal(first?.url, "https://example.com/dsh", "link → url");
	assert.equal(first?.title, "DeepSeek Harness");
	assert.equal(first?.snippet, "The DeepSeek Harness.");
	assert.equal(second?.url, "https://example.com/second");
	assert.equal(second?.title, "Second result");
	assert.equal(second?.snippet, undefined, "an omitted snippet stays absent (not '')");

	// No wire DTO field may leak onto the seam source shape.
	for (const source of result.sources) {
		assert.equal((source as unknown as Record<string, unknown>)["link"], undefined, "the 'link' wire field must not leak");
		assert.equal((source as unknown as Record<string, unknown>)["publishedAt"], undefined, "publishedAt is never synthesized");
	}
});

// ---------------------------------------------------------------------------
// Empty results (acceptance 3)
// ---------------------------------------------------------------------------

test("an empty items array is a valid zero-source result, not an error", async () => {
	const { transport } = makeTransport(() => ({ status: 200, body: EMPTY_ITEMS_BODY }));
	const provider = configuredProvider(transport);

	const result = await provider.search({ query: "nothing matches this" });
	assert.equal(result.sources.length, 0);
	assert.equal(result.truncated, false);
});

// ---------------------------------------------------------------------------
// Failure paths (acceptance 4)
// ---------------------------------------------------------------------------

test("classifyGoogleHttpError: deterministic status/reason classification", () => {
	const quotaBody = JSON.stringify({
		error: {
			code: 403,
			message: "Daily Limit Exceeded",
			status: "PERMISSION_DENIED",
			errors: [{ reason: "quotaExceeded", message: "Daily Limit Exceeded" }]
		}
	});
	const rateBody = JSON.stringify({
		error: {
			code: 429,
			message: "Rate Limit Exceeded",
			status: "RESOURCE_EXHAUSTED",
			errors: [{ reason: "rateLimitExceeded", message: "Rate Limit Exceeded" }]
		}
	});
	const accessBody = JSON.stringify({
		error: {
			code: 403,
			message: "Access Not Configured",
			status: "PERMISSION_DENIED",
			errors: [{ reason: "accessNotConfigured", message: "Access Not Configured" }]
		}
	});
	const badKeyBody = JSON.stringify({
		error: {
			code: 400,
			message: "API key not valid. Please pass a valid API key.",
			status: "INVALID_ARGUMENT"
		}
	});
	const badQueryBody = JSON.stringify({
		error: {
			code: 400,
			message: "Invalid value at 'q'",
			status: "INVALID_ARGUMENT"
		}
	});

	assert.equal(classifyGoogleHttpError(403, quotaBody), "quota", "reason quotaExceeded → quota");
	assert.equal(classifyGoogleHttpError(403, JSON.stringify({ error: { errors: [{ reason: "dailyLimitExceeded" }] } })), "quota");
	assert.equal(classifyGoogleHttpError(429, rateBody), "rate_limit", "reason rateLimitExceeded → rate_limit");
	assert.equal(classifyGoogleHttpError(429, "{}"), "rate_limit", "HTTP 429 → rate_limit without a reason");
	assert.equal(classifyGoogleHttpError(403, accessBody), "provider_failure", "accessNotConfigured is not a credential failure");
	assert.equal(classifyGoogleHttpError(403, "{}"), "invalid_credential", "HTTP 403 → invalid_credential");
	assert.equal(classifyGoogleHttpError(401, "{}"), "invalid_credential", "HTTP 401 → invalid_credential");
	assert.equal(classifyGoogleHttpError(400, badKeyBody), "invalid_credential", "the documented invalid-key 400 is an auth failure");
	assert.equal(classifyGoogleHttpError(400, badQueryBody), "invalid_request", "other 400s are invalid requests");
	assert.equal(classifyGoogleHttpError(500, "{}"), "provider_failure", "HTTP 5xx → provider_failure");
	assert.equal(classifyGoogleHttpError(404, "{}"), "provider_failure", "other non-2xx → provider_failure");
	assert.equal(classifyGoogleHttpError(403, "not json at all"), "invalid_credential", "unparseable body falls back to the status");
});

test("parseGoogleErrorDetail: defensive parsing of the documented error shape", () => {
	const detail = parseGoogleErrorDetail(
		JSON.stringify({
			error: {
				code: 403,
				message: "  Daily Limit Exceeded  ",
				status: "PERMISSION_DENIED",
				errors: [{ reason: "quotaExceeded", message: "Daily Limit Exceeded" }]
			}
		})
	);
	assert.equal(detail.reason, "quotaExceeded");
	assert.equal(detail.message, "Daily Limit Exceeded", "message is trimmed");

	assert.deepEqual(parseGoogleErrorDetail("not json"), {}, "non-JSON body → no detail");
	assert.deepEqual(parseGoogleErrorDetail(JSON.stringify([1, 2])), {}, "non-object body → no detail");
	assert.deepEqual(parseGoogleErrorDetail(JSON.stringify({ ok: true })), {}, "missing error object → no detail");
});

test("search() maps non-2xx responses to stable WebError codes (no credential leak)", async () => {
	const cases: Array<{ status: number; body: string; code: string }> = [
		{ status: 401, body: JSON.stringify({ error: { code: 401, message: "Request had insufficient authentication scope." } }), code: "INVALID_CREDENTIAL" },
		{ status: 403, body: JSON.stringify({ error: { code: 403, message: "Request denied" } }), code: "INVALID_CREDENTIAL" },
		{ status: 429, body: JSON.stringify({ error: { code: 429, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } }), code: "RATE_LIMIT" },
		{ status: 403, body: JSON.stringify({ error: { code: 403, message: "Daily Limit Exceeded", errors: [{ reason: "quotaExceeded" }] } }), code: "QUOTA" },
		{ status: 403, body: JSON.stringify({ error: { code: 403, message: "Access Not Configured", errors: [{ reason: "accessNotConfigured" }] } }), code: "PROVIDER_FAILURE" },
		{ status: 400, body: JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }), code: "INVALID_CREDENTIAL" },
		{ status: 400, body: JSON.stringify({ error: { code: 400, message: "Invalid value at 'q'" } }), code: "INVALID_REQUEST" },
		{ status: 500, body: JSON.stringify({ error: { code: 500, message: "Internal error" } }), code: "PROVIDER_FAILURE" }
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

test("search() maps a 2xx body without a usable items array to MALFORMED_RESPONSE", async () => {
	const { transport } = makeTransport(() => ({ status: 200, body: JSON.stringify({ kind: "customsearch#search" }) }));
	const provider = configuredProvider(transport);
	await expectWebError(provider.search({ query: "deepseek harness" }), "MALFORMED_RESPONSE");
});

// ---------------------------------------------------------------------------
// Transport-level failures: timeout / cancel / provider error (acceptance 4)
// ---------------------------------------------------------------------------

test("classifyGoogleFetchError: aborted signal wins; otherwise the thrown error decides", () => {
	const aborted = new AbortController();
	aborted.abort();
	const timedOut = new AbortController();
	timedOut.abort(new DOMException("The operation was aborted due to a timeout", "TimeoutError"));

	assert.equal(classifyGoogleFetchError(new Error("fetch failed"), aborted.signal), "aborted");
	assert.equal(classifyGoogleFetchError(new Error("fetch failed"), timedOut.signal), "timeout");
	assert.equal(classifyGoogleFetchError(new DOMException("The operation was aborted", "AbortError"), undefined), "aborted");
	assert.equal(
		classifyGoogleFetchError(Object.assign(new Error("timeout"), { name: "TimeoutError" }), undefined),
		"timeout"
	);
	assert.equal(classifyGoogleFetchError(new Error("fetch failed"), undefined), "provider_failure");
});

test("search() maps a transport throw to a structured WebError with the cause chained", async () => {
	const boom = new Error("fetch failed");
	const { transport } = makeTransport(() => {
		throw boom;
	});
	const provider = configuredProvider(transport);

	const err = await expectWebError(provider.search({ query: "deepseek harness" }), "PROVIDER_FAILURE");
	assert.equal((err as Error).cause, boom, "the underlying transport error is chained as cause");
});

test("search() honors an already-aborted signal (ABORTED) without any network work", async () => {
	const controller = new AbortController();
	controller.abort();
	const { transport, calls } = makeTransport((_url, signal) => {
		if (signal?.aborted) {
			throw new DOMException("The operation was aborted", "AbortError");
		}
		return { status: 200, body: SUCCESS_BODY };
	});
	const provider = configuredProvider(transport);

	const err = await expectWebError(provider.search({ query: "deepseek harness" }, controller.signal), "ABORTED");
	assert.equal(calls[0]?.signal, controller.signal, "the caller signal is forwarded to the transport");
	assert.match(err.message, /cancelled/i);
});

test("search() maps a timeout abort (TimeoutError reason) to TIMEOUT", async () => {
	const controller = new AbortController();
	controller.abort(new DOMException("The operation was aborted due to a timeout", "TimeoutError"));
	const { transport } = makeTransport((_url, signal) => {
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
	const { transport, calls } = makeTransport((_url, signal) => {
		return new Promise<GoogleHttpResponse>((resolve, reject) => {
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
	assert.equal(calls[0]?.signal, controller.signal);
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
		if (text.includes(FAKE_API_KEY) || text.includes(FAKE_CX)) {
			assert.ok(
				file.startsWith("test/"),
				`credential-shaped fixture values must stay inside test/ fixtures, found in ${file}`
			);
		}
	}
});
