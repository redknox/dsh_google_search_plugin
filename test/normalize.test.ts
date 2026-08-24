/**
 * Issue #7 acceptance tests (migration) — Gemini grounding response → DSH
 * seam normalization.
 *
 * These tests assert **conformance to the DSH seam types** (`WebSearchResult`
 * / `WebSearchSource` from `@deepseek-ai/dsh-web`), not to a plugin-local
 * domain: the helper returns the seam types directly, so the results are
 * annotated with them (compile-time conformance) and their shape is checked
 * structurally (runtime conformance). No network, no Gemini HTTP — only
 * recorded response fixtures (the fixtures mirror the real wire shape
 * captured during the Issue #7 live verification, with the grounding
 * redirect URLs replaced by example.com stand-ins).
 *
 * Acceptance coverage:
 *  - the core mapping contains no parallel result type (it returns seam types);
 *  - required vs optional fields are explicit (`url` required; `title`
 *    optional; `snippet`/`publishedAt` never invented; `content` is the
 *    provider answer, absent when there is none);
 *  - unknown/missing stays unknown/absent (blank optionals are dropped, not
 *    defaulted);
 *  - order is preserved; exact-URL duplicates are deduplicated;
 *  - absent is not malformed: a 200 response without `groundingMetadata`
 *    (Gemini's real zero-result wire shape) is a valid zero-result success,
 *    while a *present* non-array `groundingChunks` is `MALFORMED_RESPONSE`;
 *  - a malformed response is a `WebError`, never a success-shaped result.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { WebError, type WebSearchResult, type WebSearchSource } from "@deepseek-ai/dsh-web";
import { normalizeGeminiSearchResponse } from "../src/provider/normalize.js";
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

/** A realistic Gemini grounding success body (wire shape, example URLs). */
function groundingBody(answer: string, chunks: unknown[]): Record<string, unknown> {
	return {
		candidates: [
			{
				content: { parts: [{ text: answer }] },
				finishReason: "STOP",
				groundingMetadata: {
					groundingChunks: chunks,
					webSearchQueries: ["deepseek harness"]
				}
			}
		]
	};
}

/** One grounding chunk: { web: { uri, title } }. */
function chunk(uri: string, title?: string): Record<string, unknown> {
	const web: Record<string, unknown> = { uri };
	if (title !== undefined) {
		web["title"] = title;
	}
	return { web };
}

// ---------------------------------------------------------------------------
// Field mapping (Gemini wire fields → seam fields)
// ---------------------------------------------------------------------------

test("normalize: maps groundingChunks web.uri/web.title onto url/title", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("DeepSeek Harness is an open-source agent execution framework.", [
			chunk("https://example.com/dsh", "github.com"),
			chunk("https://example.com/second", "wikipedia.org")
		])
	);
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, [
		{ url: "https://example.com/dsh", title: "github.com" },
		{ url: "https://example.com/second", title: "wikipedia.org" }
	]);
});

test("normalize: maps the candidate answer text onto content", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("  The answer text.  ", [chunk("https://example.com/a", "example.com")])
	);
	assertSeamResultShape(result);
	assert.equal(result.content, "The answer text.", "the answer is trimmed and carried as content");
	assert.equal(result.sources.length, 1);
});

test("normalize: concatenates multiple answer parts in order", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse({
		candidates: [
			{
				content: { parts: [{ text: "Part one. " }, { text: "Part two." }] },
				groundingMetadata: { groundingChunks: [chunk("https://example.com/a")] }
			}
		]
	});
	assertSeamResultShape(result);
	assert.equal(result.content, "Part one. Part two.");
});

test("normalize: preserves grounding order", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("Answer.", [
			chunk("https://example.com/1", "one.example"),
			chunk("https://example.com/2", "two.example"),
			chunk("https://example.com/3", "three.example")
		])
	);
	assertSeamResultShape(result);
	assert.deepEqual(
		result.sources.map((s) => s.url),
		["https://example.com/1", "https://example.com/2", "https://example.com/3"]
	);
});

test("normalize: deduplicates exact-URL chunks (first occurrence wins)", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("Answer.", [
			chunk("https://example.com/1", "one.example"),
			chunk("https://example.com/1", "one.example"),
			chunk("https://example.com/2", "two.example")
		])
	);
	assertSeamResultShape(result);
	assert.deepEqual(
		result.sources.map((s) => s.url),
		["https://example.com/1", "https://example.com/2"]
	);
});

test("normalize: trims surrounding whitespace on mapped string fields", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("A.", [chunk("  https://example.com/a  ", "  example.com  ")])
	);
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, [{ url: "https://example.com/a", title: "example.com" }]);
});

// ---------------------------------------------------------------------------
// Optional-field discipline: absent stays absent, never invented
// ---------------------------------------------------------------------------

test("normalize: optional fields absent when Gemini omits them", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("A.", [chunk("https://example.com/a")])
	);
	assertSeamResultShape(result);
	assert.equal(result.sources.length, 1, "fixture yields exactly one source");
	const source = result.sources[0]!;
	assert.ok(!("title" in source), "title must be absent, not undefined");
	assert.ok(!("snippet" in source), "snippet must be absent, not undefined");
});

test("normalize: blank optional fields are treated as absent (not defaulted to empty string)", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("A.", [chunk("https://example.com/a", "   ")])
	);
	assertSeamResultShape(result);
	assert.equal(result.sources.length, 1, "fixture yields exactly one source");
	const source = result.sources[0]!;
	assert.ok(!("title" in source), "whitespace title must be absent");
});

test("normalize: snippet is never synthesized (the grounding response supplies none)", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("A.", [chunk("https://example.com/a", "example.com")])
	);
	assertSeamResultShape(result);
	for (const source of result.sources) {
		assert.ok(!("snippet" in source), "snippet must never be invented");
	}
});

test("normalize: publishedAt is never synthesized (the grounding response supplies no date)", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("A.", [chunk("https://example.com/a", "example.com")])
	);
	assertSeamResultShape(result);
	for (const source of result.sources) {
		assert.ok(!("publishedAt" in source), "publishedAt must never be invented");
	}
});

test("normalize: content is absent when the candidate carries no answer text", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse({
		candidates: [
			{
				content: { parts: [{ thoughtSignature: "opaque" }] },
				groundingMetadata: { groundingChunks: [chunk("https://example.com/a")] }
			}
		]
	});
	assertSeamResultShape(result);
	assert.ok(!("content" in result), "content must be absent, not empty");
	assert.equal(result.sources.length, 1, "the sources still map");
});

// ---------------------------------------------------------------------------
// truncated ownership: the seam enforces maxResults, the adapter reports false
// ---------------------------------------------------------------------------

test("normalize: truncated is always false (the DSH seam owns truncation)", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("A.", [
			chunk("https://example.com/1"),
			chunk("https://example.com/2"),
			chunk("https://example.com/3")
		])
	);
	assertSeamResultShape(result);
	assert.equal(result.truncated, false);
});

// ---------------------------------------------------------------------------
// Tolerable vs fatal malformed input
// ---------------------------------------------------------------------------

test("normalize: an empty groundingChunks array is a legitimate no-sources success", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(groundingBody("No results found.", []));
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, []);
	assert.equal(result.content, "No results found.");
	assert.equal(result.truncated, false);
});

test("normalize: a 200 response without groundingMetadata is a valid zero-result success (Gemini's real no-result shape)", () => {
	// Gemini omits `groundingMetadata` entirely when the search produced no
	// grounding (a no-result query) — absent is a fact (no results), not a
	// malformed concrete value (ENGINEERING.md §2). The answer text still
	// maps to content.
	const result: WebSearchResult = normalizeGeminiSearchResponse({
		candidates: [{ content: { parts: [{ text: "A web search yielded no results." }] }, finishReason: "STOP" }]
	});
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, []);
	assert.equal(result.content, "A web search yielded no results.");
	assert.equal(result.truncated, false);
});

test("normalize: a candidate without groundingMetadata and without answer text is MALFORMED_RESPONSE", () => {
	// A candidate that is present but yields neither answer nor sources is
	// unusable — not a silent empty success.
	assert.throws(
		() => normalizeGeminiSearchResponse({ candidates: [{ finishReason: "STOP" }] }),
		(err: unknown) => err instanceof WebError && err.code === GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE
	);
});

test("normalize: an object response without a candidates field is a valid zero-result success", () => {
	// The model produced nothing at all (no candidates): a legitimate
	// zero-result success, not malformed.
	for (const body of [{}, { modelVersion: "gemini-3.6-flash" }]) {
		const result: WebSearchResult = normalizeGeminiSearchResponse(body);
		assertSeamResultShape(result);
		assert.deepEqual(result.sources, [], `body=${JSON.stringify(body)} must yield zero sources`);
		assert.equal(result.truncated, false);
	}
});

test("normalize: a chunk without a usable web.uri is dropped (not an error)", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("A.", [
			{ title: "no web" },
			chunk("   "),
			chunk("https://example.com/ok", "ok.example")
		])
	);
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, [{ url: "https://example.com/ok", title: "ok.example" }]);
});

test("normalize: non-object chunks are dropped when usable chunks remain", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("A.", [null, 42, "x", chunk("https://example.com/ok")])
	);
	assertSeamResultShape(result);
	assert.deepEqual(result.sources, [{ url: "https://example.com/ok" }]);
});

// ---------------------------------------------------------------------------
// Malformed response → WebError (never a success-shaped result)
// ---------------------------------------------------------------------------

test("normalize: a non-object body is MALFORMED_RESPONSE", () => {
	for (const body of [null, undefined, 42, "candidates", []]) {
		assert.throws(
			() => normalizeGeminiSearchResponse(body),
			(err: unknown) =>
				err instanceof WebError && err.code === GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE,
			`body=${JSON.stringify(body)} must be malformed`
		);
	}
});

test("normalize: a present candidates field with a non-array value is MALFORMED_RESPONSE", () => {
	// Present-but-wrong-typed is malformed; *absent* is a zero-result
	// success (covered above). The distinction must not collapse.
	for (const body of [{ candidates: null }, { candidates: "nope" }, { candidates: 42 }, { candidates: { content: {} } }]) {
		assert.throws(
			() => normalizeGeminiSearchResponse(body),
			(err: unknown) =>
				err instanceof WebError && err.code === GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE,
			`body=${JSON.stringify(body)} must be malformed`
		);
	}
});

test("normalize: a present groundingChunks field with a non-array value is MALFORMED_RESPONSE", () => {
	for (const body of [{ groundingChunks: null }, { groundingChunks: "nope" }, { groundingChunks: 42 }]) {
		assert.throws(
			() =>
				normalizeGeminiSearchResponse({
					candidates: [
						{
							content: { parts: [{ text: "A." }] },
							groundingMetadata: body
						}
					]
				}),
			(err: unknown) =>
				err instanceof WebError && err.code === GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE,
			`body=${JSON.stringify(body)} must be malformed`
		);
	}
});

test("normalize: groundingChunks present but none usable is MALFORMED_RESPONSE (not an empty success)", () => {
	for (const chunks of [[null], [{ title: "no web" }], [chunk("")], [chunk("  ")], [{ web: null }]]) {
		assert.throws(
			() => normalizeGeminiSearchResponse(groundingBody("A.", chunks)),
			(err: unknown) =>
				err instanceof WebError && err.code === GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE,
			`chunks=${JSON.stringify(chunks)} must be malformed`
		);
	}
});

test("normalize: a candidate whose content.parts is present but not an array is MALFORMED_RESPONSE", () => {
	assert.throws(
		() =>
			normalizeGeminiSearchResponse({
				candidates: [{ content: { parts: "nope" }, groundingMetadata: { groundingChunks: [chunk("https://example.com/a")] } }]
			}),
		(err: unknown) => err instanceof WebError && err.code === GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE
	);
});

test("normalize: the thrown error is a WebError with a machine-routable string code", () => {
	// A present `candidates` field with a non-array value is malformed, so
	// the helper throws.
	assert.throws(
		() => normalizeGeminiSearchResponse({ candidates: "nope" }),
		(err: unknown) => {
			assert.ok(err instanceof WebError, "must be a WebError");
			assert.equal(typeof err.code, "string");
			assert.ok(err.code.length > 0, "code must be non-empty");
			assert.ok(err instanceof Error, "must be an Error");
			return true;
		}
	);
});
