/**
 * Issue #3 acceptance tests for Google-response → DSH seam normalization.
 *
 * These tests assert **conformance to the DSH seam types** (`WebSearchResult` /
 * `WebSearchSource` from `@deepseek-ai/dsh-web`), not to a plugin-local domain:
 * the helper returns the seam types directly, so the results are annotated with
 * them (compile-time conformance) and their shape is checked structurally
 * (runtime conformance). No network, no Google HTTP — only recorded response
 * fixtures.
 *
 * Acceptance coverage:
 *  - the core mapping contains no parallel result type (it returns seam types);
 *  - required vs optional fields are explicit (`url` required; `title`/
 *    `snippet` optional; `publishedAt`/`content` never invented);
 *  - unknown/missing stays unknown/absent (blank optionals are dropped, not
 *    defaulted; `publishedAt` is never synthesized);
 *  - order is preserved;
 *  - a malformed response is a `WebError`, never a success-shaped result.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { WebError, type WebSearchResult, type WebSearchSource } from "@deepseek-ai/dsh-web";
import { normalizeGoogleSearchResponse } from "../src/provider/normalize.js";
import { GOOGLE_SEARCH_ERROR_CODES } from "../src/provider/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert the runtime shape of a seam `WebSearchResult`: a `sources` array of
 * seam `WebSearchSource` objects and a boolean `truncated`. This is the
 * conformance check the reviewer asked for — the output matches the DSH seam
 * contract, not a parallel domain.
 */
function assertSeamResultShape(result: WebSearchResult): void {
	assert.equal(typeof result, "object");
	assert.ok(Array.isArray(result.sources), "sources must be an array");
	assert.equal(typeof result.truncated, "boolean", "truncated must be a boolean");
	for (const source of result.sources) {
		assertSeamSourceShape(source);
	}
}

/** Assert the runtime shape of a seam `WebSearchSource`. */
function assertSeamSourceShape(source: WebSearchSource): void {
	assert.equal(typeof source, "object");
	assert.equal(typeof source.url, "string", "url must be a string");
	assert.ok(source.url.length > 0, "url must be non-empty");
	// Optional fields, when present, are strings.
	if ("title" in source) assert.equal(typeof source.title, "string");
	if ("snippet" in source) assert.equal(typeof source.snippet, "string");
	if ("publishedAt" in source) assert.equal(typeof source.publishedAt, "string");
}

// ---------------------------------------------------------------------------
// Field mapping (Google wire fields → seam fields)
// ---------------------------------------------------------------------------

test("normalize: maps link/title/snippet onto url/title/snippet", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [
			{
				link: "https://example.com/a",
				title: "Result A",
				snippet: "Snippet A"
			}
		]
	});
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, [
		{ url: "https://example.com/a", title: "Result A", snippet: "Snippet A" }
	]);
});

test("normalize: preserves result order", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [
			{ link: "https://example.com/1", title: "one" },
			{ link: "https://example.com/2", title: "two" },
			{ link: "https://example.com/3", title: "three" }
		]
	});
	assertSeamResultShape(result);
	assert.deepEqual(
		result.sources.map((s) => s.url),
		["https://example.com/1", "https://example.com/2", "https://example.com/3"]
	);
});

test("normalize: trims surrounding whitespace on mapped string fields", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [{ link: "  https://example.com/a  ", title: "  T  ", snippet: "  S  " }]
	});
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, [{ url: "https://example.com/a", title: "T", snippet: "S" }]);
});

// ---------------------------------------------------------------------------
// Optional-field discipline: absent stays absent, never invented
// ---------------------------------------------------------------------------

test("normalize: optional fields absent when Google omits them", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [{ link: "https://example.com/a" }]
	});
	assertSeamResultShape(result);
	assert.equal(result.sources.length, 1, "fixture yields exactly one source");
	const source = result.sources[0]!;
	assert.ok(!("title" in source), "title must be absent, not undefined");
	assert.ok(!("snippet" in source), "snippet must be absent, not undefined");
});

test("normalize: blank optional fields are treated as absent (not defaulted to empty string)", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [{ link: "https://example.com/a", title: "   ", snippet: "" }]
	});
	assertSeamResultShape(result);
	assert.equal(result.sources.length, 1, "fixture yields exactly one source");
	const source = result.sources[0]!;
	assert.ok(!("title" in source), "whitespace title must be absent");
	assert.ok(!("snippet" in source), "empty snippet must be absent");
});

test("normalize: publishedAt is never synthesized (Google supplies no date)", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [{ link: "https://example.com/a", title: "T", snippet: "S" }]
	});
	assertSeamResultShape(result);
	for (const source of result.sources) {
		assert.ok(!("publishedAt" in source), "publishedAt must never be invented");
	}
});

test("normalize: content is never invented (no aggregate content in the response)", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [{ link: "https://example.com/a" }]
	});
	assert.ok(!("content" in result), "content must be absent");
});

// ---------------------------------------------------------------------------
// truncated ownership: the seam enforces maxResults, the adapter reports false
// ---------------------------------------------------------------------------

test("normalize: truncated is always false (the DSH seam owns truncation)", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [
			{ link: "https://example.com/1" },
			{ link: "https://example.com/2" },
			{ link: "https://example.com/3" }
		]
	});
	assertSeamResultShape(result);
	assert.equal(result.truncated, false);
});

// ---------------------------------------------------------------------------
// Tolerable vs fatal malformed input
// ---------------------------------------------------------------------------

test("normalize: an empty items array is a legitimate no-results success", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({ items: [] });
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, []);
	assert.equal(result.truncated, false);
});

test("normalize: an item without a usable link is dropped (not an error)", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [
			{ title: "no link" },
			{ link: "   " },
			{ link: "https://example.com/ok", title: "ok" }
		]
	});
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, [{ url: "https://example.com/ok", title: "ok" }]);
});

test("normalize: non-object items are dropped when usable items remain", () => {
	const result: WebSearchResult = normalizeGoogleSearchResponse({
		items: [null, 42, "x", { link: "https://example.com/ok" }]
	});
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, [{ url: "https://example.com/ok" }]);
});

// ---------------------------------------------------------------------------
// Malformed response → WebError (never a success-shaped result)
// ---------------------------------------------------------------------------

test("normalize: a non-object body is MALFORMED_RESPONSE", () => {
	for (const body of [null, undefined, 42, "items", []]) {
		assert.throws(
			() => normalizeGoogleSearchResponse(body),
			(err: unknown) =>
				err instanceof WebError && err.code === GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE,
			`body=${JSON.stringify(body)} must be malformed`
		);
	}
});

test("normalize: a body without an items array is MALFORMED_RESPONSE", () => {
	for (const body of [{}, { items: null }, { items: "nope" }, { search: { items: [] } }]) {
		assert.throws(
			() => normalizeGoogleSearchResponse(body),
			(err: unknown) =>
				err instanceof WebError && err.code === GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE,
			`body=${JSON.stringify(body)} must be malformed`
		);
	}
});

test("normalize: items present but none usable is MALFORMED_RESPONSE (not an empty success)", () => {
	for (const body of [{ items: [null] }, { items: [{ title: "no link" }] }, { items: [{ link: "" }] }]) {
		assert.throws(
			() => normalizeGoogleSearchResponse(body),
			(err: unknown) =>
				err instanceof WebError && err.code === GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE,
			`body=${JSON.stringify(body)} must be malformed`
		);
	}
});

test("normalize: the thrown error is a WebError with a machine-routable string code", () => {
	// A body with no `items` array at all is malformed, so the helper throws.
	assert.throws(
		() => normalizeGoogleSearchResponse({ bad: true }),
		(err: unknown) => {
			assert.ok(err instanceof WebError, "must be a WebError");
			assert.equal(typeof err.code, "string");
			assert.ok(err.code.length > 0, "code must be non-empty");
			assert.ok(err instanceof Error, "must be an Error");
			return true;
		}
	);
});
