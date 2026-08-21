/**
 * Issue #3 acceptance tests: validated provider-neutral input semantics,
 * normalized result semantics and ordering, explicit error categories, and
 * "unknown stays absent" — all without any network or Google HTTP.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	SearchError,
	isSearchError,
	normalizeSearchResults,
	validateSearchQuery
} from "../src/domain/index.js";

// ---------------------------------------------------------------------------
// validateSearchQuery — validated provider-neutral input semantics
// ---------------------------------------------------------------------------

test("validate: minimal query", () => {
	const q = validateSearchQuery({ query: "deepseek harness" });
	assert.deepEqual(q, { query: "deepseek harness" });
});

test("validate: query is trimmed and stored trimmed", () => {
	const q = validateSearchQuery({ query: "  hello world  " });
	assert.equal(q.query, "hello world");
});

test("validate: all optional fields preserved", () => {
	const q = validateSearchQuery({
		query: "x",
		limit: 5,
		language: "en",
		region: "us",
		safeSearch: true
	});
	assert.deepEqual(q, { query: "x", limit: 5, language: "en", region: "us", safeSearch: true });
});

test("validate: absent optional fields stay absent (not defaulted)", () => {
	const q = validateSearchQuery({ query: "x" });
	assert.ok(!("limit" in q), "limit must be absent, not undefined-defaulted");
	assert.ok(!("language" in q));
	assert.ok(!("region" in q));
	assert.ok(!("safeSearch" in q), "safeSearch must never be defaulted to false");
});

test("validate: language/region are trimmed", () => {
	const q = validateSearchQuery({ query: "x", language: "  en ", region: " us " });
	assert.equal(q.language, "en");
	assert.equal(q.region, "us");
});

test("validate: unknown fields are projected away (not accepted, not errors)", () => {
	const q = validateSearchQuery({ query: "x", someUnknownField: 123, another: "y" });
	assert.deepEqual(q, { query: "x" });
});

test("validate: missing query is invalid_request", () => {
	assert.throws(
		() => validateSearchQuery({}),
		(err: unknown) => isSearchError(err) && err.code === "invalid_request"
	);
});

test("validate: non-string query is invalid_request", () => {
	assert.throws(
		() => validateSearchQuery({ query: 42 }),
		(err: unknown) => isSearchError(err) && err.code === "invalid_request"
	);
});

test("validate: empty/whitespace query is invalid_request", () => {
	assert.throws(() => validateSearchQuery({ query: "" }), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
	assert.throws(() => validateSearchQuery({ query: "   " }), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
});

test("validate: null / array / primitive input is invalid_request", () => {
	assert.throws(() => validateSearchQuery(null), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
	assert.throws(() => validateSearchQuery(["x"]), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
	assert.throws(() => validateSearchQuery("x"), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
});

test("validate: non-integer / non-positive limit is invalid_request", () => {
	for (const bad of [0, -1, 1.5, "5", true, null, undefined as unknown as number]) {
		if (bad === undefined) continue; // undefined means absent — valid
		assert.throws(
			() => validateSearchQuery({ query: "x", limit: bad }),
			(e: unknown) => isSearchError(e) && e.code === "invalid_request",
			`limit=${String(bad)} must be rejected`
		);
	}
});

test("validate: limit=1 is accepted (minimum positive integer)", () => {
	assert.equal(validateSearchQuery({ query: "x", limit: 1 }).limit, 1);
});

test("validate: non-string / empty language or region is invalid_request", () => {
	assert.throws(() => validateSearchQuery({ query: "x", language: 1 }), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
	assert.throws(() => validateSearchQuery({ query: "x", language: "  " }), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
	assert.throws(() => validateSearchQuery({ query: "x", region: "" }), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
});

test("validate: non-boolean safeSearch is invalid_request", () => {
	assert.throws(() => validateSearchQuery({ query: "x", safeSearch: "yes" }), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
	assert.throws(() => validateSearchQuery({ query: "x", safeSearch: 1 }), (e: unknown) => isSearchError(e) && e.code === "invalid_request");
});

test("validate: multiple violations are all reported", () => {
	assert.throws(
		() => validateSearchQuery({ query: "", limit: 0, safeSearch: "no" }),
		(err: unknown) => {
			assert.ok(isSearchError(err), "expected SearchError, got " + String(err));
			const se = err as SearchError;
			assert.match(se.message, /query/);
			assert.match(se.message, /limit/);
			assert.match(se.message, /safeSearch/);
			return true;
		}
	);
});

// ---------------------------------------------------------------------------
// normalizeSearchResults — normalized result semantics and ordering
// ---------------------------------------------------------------------------

test("normalize: empty list is a valid empty outcome", () => {
	const out = normalizeSearchResults([]);
	assert.deepEqual(out, { results: [], truncated: false });
});

test("normalize: full result preserved in provider order", () => {
	const out = normalizeSearchResults([
		{ url: "https://a.example", title: "A", snippet: "sa", source: "s" },
		{ url: "https://b.example", title: "B", snippet: "sb", source: "s2" }
	]);
	assert.equal(out.results.length, 2);
	assert.deepEqual(out.results[0], { url: "https://a.example", title: "A", snippet: "sa", source: "s" });
	assert.deepEqual(out.results[1], { url: "https://b.example", title: "B", snippet: "sb", source: "s2" });
	assert.equal(out.truncated, false);
});

test("normalize: ordering is exactly the provider's returned order (no reordering)", () => {
	const out = normalizeSearchResults([
		{ url: "https://3.example" },
		{ url: "https://1.example" },
		{ url: "https://2.example" }
	]);
	assert.deepEqual(
		out.results.map((r) => r.url),
		["https://3.example", "https://1.example", "https://2.example"]
	);
});

test("normalize: optional fields absent when not supplied (no fabricated values)", () => {
	const out = normalizeSearchResults([{ url: "https://x.example" }]);
	assert.deepEqual(out.results[0], { url: "https://x.example" });
	assert.ok(!("title" in out.results[0]!), "title must be absent, not ''");
	assert.ok(!("snippet" in out.results[0]!));
	assert.ok(!("source" in out.results[0]!));
});

test("normalize: empty-string optional fields are treated as absent", () => {
	const out = normalizeSearchResults([{ url: "https://x.example", title: "", snippet: "   ", source: null }]);
	const r = out.results[0]!;
	assert.ok(!("title" in r));
	assert.ok(!("snippet" in r));
	assert.ok(!("source" in r));
});

test("normalize: items without a usable url are dropped", () => {
	const out = normalizeSearchResults([
		{ title: "no url" },
		{ url: "" },
		{ url: "   " },
		{ url: 42 },
		{ url: "https://ok.example", title: "ok" },
		"not-an-object",
		null
	]);
	assert.deepEqual(out.results, [{ url: "https://ok.example", title: "ok" }]);
});

test("normalize: non-array provider response is malformed_response", () => {
	for (const bad of ["nope", 42, null, { results: [] }, undefined]) {
		assert.throws(
			() => normalizeSearchResults(bad),
			(e: unknown) => isSearchError(e) && e.code === "malformed_response",
			`non-array ${String(bad)} must be malformed_response`
		);
	}
});

test("normalize: non-empty list with no usable result is malformed_response (never hidden as empty success)", () => {
	assert.throws(
		() => normalizeSearchResults([{ title: "no url" }, { url: "" }]),
		(e: unknown) => isSearchError(e) && e.code === "malformed_response"
	);
});

test("normalize: limit bounds results and sets truncated", () => {
	const raw = [
		{ url: "https://1.example" },
		{ url: "https://2.example" },
		{ url: "https://3.example" },
		{ url: "https://4.example" }
	];
	const out = normalizeSearchResults(raw, 2);
	assert.deepEqual(
		out.results.map((r) => r.url),
		["https://1.example", "https://2.example"]
	);
	assert.equal(out.truncated, true);
});

test("normalize: limit equal to result count is not truncated", () => {
	const out = normalizeSearchResults(
		[{ url: "https://1.example" }, { url: "https://2.example" }],
		2
	);
	assert.equal(out.results.length, 2);
	assert.equal(out.truncated, false);
});

test("normalize: limit larger than result count is not truncated", () => {
	const out = normalizeSearchResults([{ url: "https://1.example" }], 10);
	assert.equal(out.results.length, 1);
	assert.equal(out.truncated, false);
});

test("normalize: limit 1 keeps the first result only", () => {
	const out = normalizeSearchResults(
		[{ url: "https://1.example", title: "one" }, { url: "https://2.example" }],
		1
	);
	assert.deepEqual(out.results, [{ url: "https://1.example", title: "one" }]);
	assert.equal(out.truncated, true);
});
