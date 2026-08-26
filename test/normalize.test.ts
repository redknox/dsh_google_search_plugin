/**
 * Issue #7 acceptance tests (migration, re-review compliance pass) — Gemini
 * grounding response → DSH seam normalization.
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
 *    optional; `snippet`/`publishedAt` never invented; `content` carries the
 *    grounded answer — inline citation markers plus the provider-supplied
 *    Search Suggestion artifact verbatim — and is absent when there is
 *    nothing to carry);
 *  - the grounded artifact is preserved end to end: the answer, its citation
 *    markers (from `groundingSupports`, resolved against the `sources` list
 *    the DSH tool renders right after `content`), and the **provider-supplied
 *    Search Suggestion artifact** (`searchEntryPoint.renderedContent`, carried
 *    byte-for-byte) all reach the seam result — none of them is discarded;
 *  - the Search Suggestion is **preserved, not fabricated**: `webSearchQueries`
 *    (the executed queries) is a different field and is never turned into
 *    display links; a response with queries but no `searchEntryPoint` carries
 *    no suggestion section;
 *  - the grounding chunks are **evidence, not a claimed ranking**: the
 *    source order is the response's chunk order, and no test or comment
 *    asserts a SERP ranking;
 *  - unknown/missing stays unknown/absent (blank optionals are dropped, not
 *    defaulted);
 *  - order is preserved; exact-URL duplicates are deduplicated;
 *  - absent is not malformed, and absent is not "zero search results": a 200
 *    response without `groundingMetadata` carries *zero grounding sources*
 *    (the wire does not say whether a search ran and found nothing), while a
 *    *present* non-array `groundingChunks` is `MALFORMED_RESPONSE`;
 *  - citation markers are clamped to the seam's `maxResults` bound (a marker
 *    pointing at a source the seam will truncate would dangle);
 *  - a malformed response is a `WebError`, never a success-shaped result.
 *
 * The tests assert **preservation of the provider artifact**, not a
 * compliance claim: the DSH seam carries `content` as an inert string into
 * the model context but renders tool output as plain text only, so the
 * supplied HTML+CSS Search Suggestion is carried but not rendered as a
 * widget to the end user. That host-contract boundary is documented in
 * ARCHITECTURE.md and the E2E report, not asserted here as satisfied.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { WebError, type WebSearchResult, type WebSearchSource } from "@deepseek-ai/dsh-web";
import { GEMINI_SEARCH_SUGGESTION_LABEL, normalizeGeminiSearchResponse } from "../src/provider/normalize.js";
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

/**
 * A realistic Gemini grounding success body (wire shape, example URLs).
 * Carries the provider-supplied Search Suggestion artifact
 * (`searchEntryPoint.renderedContent`, a stand-in HTML+CSS snippet), the
 * executed `webSearchQueries` (a *different* field — the model's queries, not
 * the suggestion), and, when `supports` is given, the
 * `groundingSupports` citation relationship.
 */
export const EXAMPLE_RENDERED_CONTENT =
	"<style>\n.container { display: flex; font-family: Google Sans, sans-serif; }\n.chip { display: inline-block; border-radius: 16px; }\n</style>\n" +
	'<div class="container"><a class="chip" href="https://www.google.com/search?q=deepseek+harness&amp;client=app-vertex-grounding">deepseek harness</a></div>';

function groundingBody(
	answer: string,
	chunks: unknown[],
	supports?: unknown[]
): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		groundingChunks: chunks,
		// The provider-supplied Search Suggestion artifact (verbatim source).
		searchEntryPoint: { renderedContent: EXAMPLE_RENDERED_CONTENT },
		// The queries the model executed — a separate field, NOT the
		// suggestion. Kept in the fixture to prove the adapter does not
		// conflate the two.
		webSearchQueries: ["deepseek harness AI tool", "what is deepseek harness"]
	};
	if (supports !== undefined) {
		metadata["groundingSupports"] = supports;
	}
	return {
		candidates: [
			{
				content: { parts: [{ text: answer }] },
				finishReason: "STOP",
				groundingMetadata: metadata
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

/** One grounding support: an answer segment backed by chunk indices. */
function support(startIndex: number, endIndex: number, text: string, chunkIndices: number[]): Record<string, unknown> {
	return {
		segment: { startIndex, endIndex, text },
		groundingChunkIndices: chunkIndices
	};
}

/**
 * The expected Search Suggestion section for the default fixture: the label
 * (the adapter's own framing) followed by the provider artifact **verbatim**.
 */
const DEFAULT_SUGGESTION_SECTION = `${GEMINI_SEARCH_SUGGESTION_LABEL}\n${EXAMPLE_RENDERED_CONTENT}`;

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

test("normalize: maps the candidate answer text onto content (with the provider Search Suggestion appended verbatim)", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("  The answer text.  ", [chunk("https://example.com/a", "example.com")])
	);
	assertSeamResultShape(result);
	assert.equal(
		result.content,
		`The answer text.\n\n${DEFAULT_SUGGESTION_SECTION}`,
		"the answer is trimmed, carried as content, followed by the provider artifact verbatim"
	);
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

test("normalize: preserves the response's chunk order (evidence order, not a claimed ranking)", () => {
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
// Grounded artifact preservation: citations + provider Search Suggestion end to end
// ---------------------------------------------------------------------------

test("normalize: the provider-supplied Search Suggestion artifact is preserved verbatim (byte-for-byte)", () => {
	const artifact =
		"<style>\n.chip { border-radius: 16px; }\n</style>\n" +
		'<div class="container"><a class="chip" href="https://www.google.com/search?q=alpha+query&amp;client=app-vertex-grounding">alpha query</a></div>';
	const result: WebSearchResult = normalizeGeminiSearchResponse({
		candidates: [
			{
				content: { parts: [{ text: "Answer." }] },
				groundingMetadata: {
					groundingChunks: [chunk("https://example.com/a")],
					searchEntryPoint: { renderedContent: artifact }
				}
			}
		]
	});
	assertSeamResultShape(result);
	assert.equal(
		result.content,
		`Answer.\n\n${GEMINI_SEARCH_SUGGESTION_LABEL}\n${artifact}`,
		"the artifact is carried verbatim — no rewriting, sanitizing, or reconstruction"
	);
});

test("normalize: an artifact with leading/trailing whitespace survives byte-for-byte (no boundary trim)", () => {
	// Regression: the content assembly must not trim the provider artifact's
	// boundary bytes. An artifact that begins and ends with whitespace
	// (including a trailing newline) must be the exact suffix of the
	// returned content — `includes` alone would not catch a trim.
	const artifact =
		"\n  <style>\n.chip { border-radius: 16px; }\n</style>\n" +
		'<div class="container"><a class="chip" href="https://www.google.com/search?q=alpha+query&amp;client=app-vertex-grounding">alpha query</a></div>\n\n';
	const result: WebSearchResult = normalizeGeminiSearchResponse({
		candidates: [
			{
				content: { parts: [{ text: "Answer." }] },
				groundingMetadata: {
					groundingChunks: [chunk("https://example.com/a")],
					searchEntryPoint: { renderedContent: artifact }
				}
			}
		]
	});
	assertSeamResultShape(result);
	assert.ok(
		result.content !== undefined && result.content.endsWith(artifact),
		"the content ENDS WITH the exact artifact bytes (leading/trailing whitespace untouched)"
	);
	assert.equal(
		result.content,
		`Answer.\n\n${GEMINI_SEARCH_SUGGESTION_LABEL}\n${artifact}`,
		"exact content: trimmed answer + label + artifact, artifact bytes unchanged"
	);
	// The answer's own boundary whitespace is still normalized (plugin-owned
	// text only).
	const padded = normalizeGeminiSearchResponse({
		candidates: [
			{
				content: { parts: [{ text: "  Answer.  " }] },
				groundingMetadata: {
					groundingChunks: [chunk("https://example.com/a")],
					searchEntryPoint: { renderedContent: artifact }
				}
			}
		]
	});
	assert.equal(
		padded.content,
		`Answer.\n\n${GEMINI_SEARCH_SUGGESTION_LABEL}\n${artifact}`,
		"the answer is trimmed; the artifact is not"
	);
});

test("normalize: webSearchQueries is NOT turned into display links (the suggestion is the provider artifact, not a fabrication)", () => {
	// The executed queries are a different field from the Search Suggestion.
	// Turning them into display links would fabricate a suggestion Google did
	// not supply — the adapter must not do that.
	const result: WebSearchResult = normalizeGeminiSearchResponse({
		candidates: [
			{
				content: { parts: [{ text: "Answer." }] },
				groundingMetadata: {
					groundingChunks: [chunk("https://example.com/a")],
					webSearchQueries: ["alpha query", "beta gamma"]
					// no searchEntryPoint: the provider supplied no artifact
				}
			}
		]
	});
	assertSeamResultShape(result);
	assert.equal(
		result.content,
		"Answer.",
		"queries alone produce no suggestion section and no fabricated links"
	);
	assert.ok(!result.content!.includes("google.com/search"), "no fabricated search link may appear");
});

test("normalize: the suggestion section is absent when the provider supplies no searchEntryPoint", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("Answer.", [chunk("https://example.com/a")])
	);
	// The default fixture DOES carry a searchEntryPoint, so the section is
	// present; strip it to prove absence when the provider omits it.
	const body: Record<string, unknown> = {
		candidates: [
			{
				content: { parts: [{ text: "Answer." }] },
				groundingMetadata: {
					groundingChunks: [chunk("https://example.com/a")],
					webSearchQueries: ["deepseek harness"]
				}
			}
		]
	};
	const stripped: WebSearchResult = normalizeGeminiSearchResponse(body);
	assertSeamResultShape(stripped);
	assert.equal(stripped.content, "Answer.", "no artifact, no section");
	assertSeamResultShape(result);
	assert.ok(result.content!.includes(GEMINI_SEARCH_SUGGESTION_LABEL), "with the artifact, the section is present");
});

test("normalize: a searchEntryPoint with a blank renderedContent is treated as absent (not malformed, not fabricated)", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse({
		candidates: [
			{
				content: { parts: [{ text: "Answer." }] },
				groundingMetadata: {
					groundingChunks: [chunk("https://example.com/a")],
					searchEntryPoint: { renderedContent: "   " }
				}
			}
		]
	});
	assertSeamResultShape(result);
	assert.equal(result.content, "Answer.", "a blank artifact is carried as absent, never replaced");
});

test("normalize: inline citation markers are inserted after each cited answer segment", () => {
	const answer = "The harness is open source. It runs agents.";
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody(answer, [
			chunk("https://example.com/a", "a.example"),
			chunk("https://example.com/b", "b.example")
		], [
			support(0, 25, "The harness is open source.", [0]),
			support(25, 43, " It runs agents.", [1])
		])
	);
	assertSeamResultShape(result);
	assert.equal(
		result.content,
		`The harness is open source.[1] It runs agents.[2]\n\n${DEFAULT_SUGGESTION_SECTION}`,
		"markers [n] are 1-based into the sources array the tool renders after content"
	);
});

test("normalize: a support citing multiple chunks gets a merged marker", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("One fact.", [
			chunk("https://example.com/a"),
			chunk("https://example.com/b"),
			chunk("https://example.com/c")
		], [support(0, 9, "One fact.", [0, 2])])
	);
	assertSeamResultShape(result);
	assert.ok(result.content!.startsWith("One fact.[1, 3]"), `got: ${result.content}`);
});

test("normalize: a chunk duplicating an earlier URL cites the first source (dedup rule)", () => {
	// Chunk 1 duplicates chunk 0's URL, so it maps to source 1 (1-based),
	// not a second entry — the marker must resolve against the list the
	// end user sees.
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("Fact.", [
			chunk("https://example.com/a"),
			chunk("https://example.com/a", "dup.example"),
			chunk("https://example.com/b")
		], [support(0, 5, "Fact.", [1])])
	);
	assertSeamResultShape(result);
	assert.equal(result.sources.length, 2, "the duplicate chunk is deduplicated");
	assert.ok(result.content!.startsWith("Fact.[1]"), `got: ${result.content}`);
});

test("normalize: citation markers are clamped to maxResults (no dangling markers)", () => {
	const answer = "First part. Second part.";
	const supports = [
		support(0, 12, "First part.", [0]),
		support(12, 25, " Second part.", [1])
	];
	const body = groundingBody(answer, [
		chunk("https://example.com/1"),
		chunk("https://example.com/2"),
		chunk("https://example.com/3")
	], supports);

	// Without a bound: both markers survive.
	const unbounded: WebSearchResult = normalizeGeminiSearchResponse(body);
	assert.ok(unbounded.content!.startsWith("First part.[1] Second part.[2]"), `got: ${unbounded.content}`);

	// With maxResults=1: the seam keeps only the first source, so the marker
	// citing source 2 is dropped (it would dangle after the seam truncates).
	const bounded: WebSearchResult = normalizeGeminiSearchResponse(body, 1);
	assertSeamResultShape(bounded);
	assert.ok(bounded.content!.startsWith("First part.[1] Second part."), `got: ${bounded.content}`);
	assert.equal(bounded.truncated, false, "the adapter still reports truncated: false (the seam owns truncation)");
});

test("normalize: a support whose segments are all truncated away is skipped", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("Only one.", [
			chunk("https://example.com/1"),
			chunk("https://example.com/2")
		], [support(0, 11, "Only one.", [1])]),
		1
	);
	assertSeamResultShape(result);
	assert.ok(result.content!.startsWith("Only one.\n\n"), `got: ${result.content}`);
});

test("normalize: a segment the model paraphrased (not found in the answer) is skipped", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("The actual answer.", [chunk("https://example.com/a")], [
			support(0, 10, "A different wording.", [0])
		])
	);
	assertSeamResultShape(result);
	assert.ok(result.content!.startsWith("The actual answer.\n\n"), `got: ${result.content}`);
});

test("normalize: overlapping segments that end at the same point merge their markers", () => {
	const result: WebSearchResult = normalizeGeminiSearchResponse(
		groundingBody("Shared fact.", [
			chunk("https://example.com/a"),
			chunk("https://example.com/b")
		], [
			support(0, 12, "Shared fact.", [0]),
			support(7, 12, "fact.", [1])
		])
	);
	assertSeamResultShape(result);
	assert.ok(result.content!.startsWith("Shared fact.[1, 2]"), `got: ${result.content}`);
});

test("normalize: content carries only the provider artifact when the answer is absent but a suggestion exists", () => {
	const artifact = '<div class="container"><a class="chip" href="https://www.google.com/search?q=lonely+query">lonely query</a></div>';
	const result: WebSearchResult = normalizeGeminiSearchResponse({
		candidates: [
			{
				content: { parts: [{ thoughtSignature: "opaque" }] },
				groundingMetadata: {
					groundingChunks: [chunk("https://example.com/a")],
					searchEntryPoint: { renderedContent: artifact }
				}
			}
		]
	});
	assertSeamResultShape(result);
	assert.equal(result.content, `${GEMINI_SEARCH_SUGGESTION_LABEL}\n${artifact}`);
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

test("normalize: content is absent when the candidate carries no answer text and no provider artifact", () => {
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
	assert.equal(result.content, `No results found.\n\n${DEFAULT_SUGGESTION_SECTION}`);
	assert.equal(result.truncated, false);
});

test("normalize: a 200 response without groundingMetadata carries zero grounding sources (a valid zero-source success)", () => {
	// Gemini omits `groundingMetadata` entirely when it produced no grounding
	// for the response. That is the wire fact — *zero grounding sources*. It
	// is not observable from the wire that a search ran and found zero
	// results, so the claim stays at the safe level (ENGINEERING.md §2, §5).
	// The answer text still maps to content.
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

test("normalize: an object response without a candidates field carries zero grounding sources (a valid zero-source success)", () => {
	// The model produced nothing at all (no candidates): a legitimate
	// zero-source success, not malformed.
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
	// Present-but-wrong-typed is malformed; *absent* is a zero-source
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
