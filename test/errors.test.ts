/**
 * Issue #3 acceptance tests for Google-failure → `WebError` mapping.
 *
 * These tests assert **conformance to the DSH error type** (`WebError` from
 * `@deepseek-ai/dsh-web`), not to a plugin-local error class: the helper
 * returns a `WebError`, so the output is checked against that type
 * (compile-time) and its shape (runtime). No network, no Google HTTP.
 *
 * Acceptance coverage:
 *  - the stable error type is the DSH `WebError` (not a parallel class);
 *  - the `code` is a machine-routable **string** compatible with the open
 *    string contract (a router can branch on it; consumers tolerate unknowns);
 *  - the failure classes the issue requires are each distinguishable by code;
 *  - where the DSH harness publishes a shared code for the same class, the
 *    adapter reuses that exact string (consistency with the harness taxonomy);
 *  - the code space is *not* closed locally: the emitted codes are a subset of
 *    the open `WebError.code` string space, not a closed union contract.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { WebError } from "@deepseek-ai/dsh-web";
import { QUOTA_EXCEEDED_CODE, INVALID_CREDENTIAL_CODE } from "@deepseek-ai/dsh-llm";
import {
	GOOGLE_SEARCH_ERROR_CODES,
	mapGoogleSearchFailure,
	type GoogleSearchFailureClass
} from "../src/provider/errors.js";

// ---------------------------------------------------------------------------
// Conformance to the DSH error type
// ---------------------------------------------------------------------------

test("errors: every failure class maps to a WebError (the DSH error type)", () => {
	const classes: GoogleSearchFailureClass[] = [
		"invalid_request",
		"missing_credential",
		"invalid_credential",
		"rate_limit",
		"quota",
		"timeout",
		"aborted",
		"provider_failure",
		"malformed_response"
	];
	for (const failureClass of classes) {
		const err = mapGoogleSearchFailure(failureClass, "detail");
		assert.ok(err instanceof WebError, `${failureClass} must produce a WebError`);
		assert.ok(err instanceof Error, `${failureClass} must produce an Error`);
		assert.equal(err.name, "WebError", `${failureClass} must be named WebError`);
	}
});

test("errors: the code is a non-empty machine-routable string (open-string contract)", () => {
	const err = mapGoogleSearchFailure("provider_failure", "boom");
	assert.equal(typeof err.code, "string");
	assert.ok(err.code.length > 0, "code must be non-empty");
});

test("errors: the message is preserved and the cause is chained when provided", () => {
	const cause = new Error("underlying transport failure");
	const err = mapGoogleSearchFailure("provider_failure", "upstream 500", cause);
	assert.equal(err.message, "upstream 500");
	assert.equal(err.cause, cause, "cause must be chained via Error.cause");

	const noCause = mapGoogleSearchFailure("provider_failure", "upstream 500");
	assert.equal(noCause.cause, undefined, "cause must be absent when not provided");
});

// ---------------------------------------------------------------------------
// Each required failure class is distinguishable by a stable code
// ---------------------------------------------------------------------------

test("errors: each failure class maps to its distinct, stable code", () => {
	const expected: Record<GoogleSearchFailureClass, string> = {
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
	const codes = new Set<string>();
	for (const [failureClass, code] of Object.entries(expected)) {
		const err = mapGoogleSearchFailure(failureClass as GoogleSearchFailureClass, "x");
		assert.equal(err.code, code, `${failureClass} must map to ${code}`);
		codes.add(code);
	}
	// All nine classes are distinguishable — no two share a code.
	assert.equal(codes.size, 9, "the nine failure classes must map to nine distinct codes");
});

// ---------------------------------------------------------------------------
// Consistency with the DSH shared taxonomy (verbatim reuse where it exists)
// ---------------------------------------------------------------------------

test("errors: quota reuses the DSH shared QUOTA code verbatim", () => {
	const err = mapGoogleSearchFailure("quota", "quota exhausted");
	assert.equal(err.code, QUOTA_EXCEEDED_CODE, "must equal the dsh-llm QUOTA code");
	assert.equal(err.code, "QUOTA");
});

test("errors: invalid credential reuses the DSH shared INVALID_CREDENTIAL code verbatim", () => {
	const err = mapGoogleSearchFailure("invalid_credential", "bad key");
	assert.equal(err.code, INVALID_CREDENTIAL_CODE, "must equal the dsh-llm INVALID_CREDENTIAL code");
	assert.equal(err.code, "INVALID_CREDENTIAL");
});

test("errors: rate_limit / timeout / aborted match the DSH shared taxonomy strings", () => {
	// These three are the DSH shared `code` strings (documented in dsh-llm's
	// error taxonomy) but are not exported as named constants, so they are
	// asserted against the documented literal values.
	assert.equal(mapGoogleSearchFailure("rate_limit", "x").code, "RATE_LIMIT");
	assert.equal(mapGoogleSearchFailure("timeout", "x").code, "TIMEOUT");
	assert.equal(mapGoogleSearchFailure("aborted", "x").code, "ABORTED");
});

// ---------------------------------------------------------------------------
// The code space is not closed locally
// ---------------------------------------------------------------------------

test("errors: emitted codes are a subset of the open string space, not a closed union", () => {
	// The adapter's codes are specific string values. The DSH contract types
	// `WebError.code` as an open `string`, so a router that does not know a
	// code must tolerate it. We assert the emitted codes are plain strings
	// (the open-space members), and that the adapter's own constant object is
	// a *subset* of that space — it does not redefine the contract.
	const values: string[] = Object.values(GOOGLE_SEARCH_ERROR_CODES);
	assert.ok(values.length > 0);
	for (const value of values) {
		assert.equal(typeof value, "string", "each adapter code is a string");
		assert.ok(value.length > 0);
	}
	// The DSH seam's own selection codes live in the same open space and are
	// distinct from the adapter's codes — the adapter does not shadow them.
	for (const seamCode of [
		"WEB_PROVIDER_CONFIGURED_MISSING",
		"WEB_PROVIDER_CONFIGURED_UNAVAILABLE",
		"WEB_PROVIDER_AMBIGUOUS",
		"WEB_PROVIDER_UNAVAILABLE",
		"WEB_DUPLICATE_PROVIDER"
	]) {
		assert.ok(!values.includes(seamCode), `adapter codes must not shadow seam code ${seamCode}`);
	}
});
