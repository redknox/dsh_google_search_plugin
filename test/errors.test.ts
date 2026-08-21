/**
 * Issue #3 acceptance: the explicit error categories are stable and
 * machine-routable. The code set is closed and known; every failure carries
 * a code a consumer can switch on, never a message to parse.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	SEARCH_ERROR_CODES,
	SearchError,
	isSearchError,
	normalizeSearchResults,
	validateSearchQuery
} from "../src/domain/index.js";

test("the error category set is exactly the six documented categories plus malformed_response", () => {
	assert.deepEqual(SEARCH_ERROR_CODES, [
		"invalid_request",
		"auth_failure",
		"capability_unavailable",
		"rate_limited",
		"timeout_or_cancellation",
		"provider_failure",
		"malformed_response"
	]);
});

test("SearchError carries a stable code and is an Error", () => {
	const err = new SearchError("rate_limited", "quota exhausted");
	assert.ok(err instanceof Error);
	assert.ok(err instanceof SearchError);
	assert.ok(isSearchError(err));
	assert.equal(err.code, "rate_limited");
	assert.equal(err.name, "SearchError");
	assert.equal(err.message, "quota exhausted");
});

test("SearchError preserves the underlying cause without changing the category", () => {
	const underlying = new Error("socket hang up");
	const err = new SearchError("provider_failure", "provider call failed", underlying);
	assert.equal(err.code, "provider_failure");
	assert.equal(err.cause, underlying);
	// The structured Error#cause is also populated for standard tooling.
	assert.equal((err as Error & { cause?: unknown }).cause, underlying);
});

test("SearchError without a cause leaves cause undefined (not fabricated)", () => {
	const err = new SearchError("auth_failure", "missing credential");
	assert.equal(err.cause, undefined);
});

test("isSearchError is false for plain errors and non-errors", () => {
	assert.equal(isSearchError(new Error("nope")), false);
	assert.equal(isSearchError({ code: "rate_limited" }), false);
	assert.equal(isSearchError("rate_limited"), false);
	assert.equal(isSearchError(null), false);
	assert.equal(isSearchError(undefined), false);
});

test("invalid input routes to invalid_request (machine-routable)", () => {
	try {
		validateSearchQuery({ query: "" });
		assert.fail("expected throw");
	} catch (err) {
		assert.ok(isSearchError(err), "expected SearchError, got " + String(err));
		// A router switches on this stable code.
		assert.equal((err as SearchError).code, "invalid_request");
	}
});

test("malformed provider response routes to malformed_response (machine-routable)", () => {
	try {
		normalizeSearchResults("not a list");
		assert.fail("expected throw");
	} catch (err) {
		assert.ok(isSearchError(err), "expected SearchError, got " + String(err));
		assert.equal((err as SearchError).code, "malformed_response");
	}
});

test("capability_unavailable is a distinct, routable category (no backend wired)", () => {
	// The tool layer raises this; here we assert the category exists and is
	// distinct from a request failure, per ENGINEERING.md §7.
	assert.ok(SEARCH_ERROR_CODES.includes("capability_unavailable"));
	assert.notEqual("capability_unavailable", "provider_failure");
	const err = new SearchError("capability_unavailable", "no search backend wired");
	assert.equal(err.code, "capability_unavailable");
});

test("every code is a non-empty, distinct, lowercase snake_case token", () => {
	const seen = new Set<string>();
	for (const code of SEARCH_ERROR_CODES) {
		assert.match(code, /^[a-z][a-z0-9_]*$/);
		assert.ok(!seen.has(code), `duplicate code ${code}`);
		seen.add(code);
	}
});
