/**
 * Gemini `google_search` grounding response → DSH seam result normalization
 * (Issue #7 migration).
 *
 * This is a **Google-adapter-owned** helper: it is the only place in the
 * plugin that knows the Gemini wire field names (`candidates`, `parts`,
 * `text`, `groundingMetadata`, `groundingChunks`, `web`, `uri`, `title`). It
 * translates a parsed Gemini API `generateContent` response (with the
 * `google_search` tool) into the stable, provider-neutral seam types from
 * `@deepseek-ai/dsh-web` (`WebSearchResult` / `WebSearchSource`). It does
 * **not** define a parallel result type and does **not** close any contract:
 * the DSH seam types are the contract, imported here.
 *
 * Field mapping (Gemini → seam):
 *   - `candidates[0].content.parts[].text` (concatenated) → `content`
 *     (the provider-generated answer; absent when there is no answer text)
 *   - `groundingMetadata.groundingChunks[].web.uri` → `url`
 *     (required; a chunk without a usable `uri` is dropped)
 *   - `groundingMetadata.groundingChunks[].web.title` → `title`
 *     (optional; in practice the source's hostname, e.g. `wikipedia.org`)
 *
 * Fields the seam defines but Gemini does **not** supply are left **absent**,
 * never invented:
 *   - `snippet`     — the grounding response carries no per-source snippet
 *     (`groundingSupports[].segment.text` is a segment of the *answer*, not
 *     a source snippet; mapping it would misrepresent it).
 *   - `publishedAt` — the grounding response carries no publication date.
 *
 * `truncated` is owned by the DSH seam, which enforces `maxResults` on the
 * way back and sets the flag itself. This helper therefore always reports
 * `truncated: false` and does **not** apply any limit — duplicating the
 * seam's truncation would double-count it.
 *
 * A response that cannot be mapped onto the seam shape is a *malformed
 * response*, not a silent success: it throws a `WebError` with the
 * `MALFORMED_RESPONSE` code (see {@link ./errors.js}). Per ENGINEERING.md §7
 * a failure is never hidden behind a success-shaped result.
 *
 * **Absent is not malformed** (ENGINEERING.md §2): Gemini omits
 * `groundingMetadata` entirely when the search produced no grounding (a
 * no-result query), so a valid 200 response *without* `groundingMetadata` is
 * a legitimate zero-result success (the answer text, when any, still maps to
 * `content`). Only a `groundingChunks` field that is *present* with a
 * non-array value, or a candidate that is present but yields neither answer
 * text nor usable sources, is malformed — the distinction between *absent*
 * and *malformed concrete value* is preserved, not collapsed.
 */

import { WebError, type WebSearchResult, type WebSearchSource } from "@deepseek-ai/dsh-web";
import { GOOGLE_SEARCH_ERROR_CODES } from "./errors.js";

/**
 * Normalize a parsed Gemini API `generateContent` response body (with the
 * `google_search` tool) into a DSH seam {@link WebSearchResult}.
 *
 * @param body - the parsed JSON body of a successful (2xx) Gemini response.
 *   Error bodies (auth, rate limit, 5xx) are classified by the transport
 *   layer before this helper is reached and are not malformed responses.
 * @returns a `WebSearchResult` whose `sources` preserve the grounding order
 *   (deduplicated by exact URL), with `truncated: false` (the seam owns
 *   truncation) and the answer text as `content` when present. A response
 *   without `candidates`, or with no `groundingMetadata` (Gemini's real
 *   zero-result wire shape), is a legitimate zero-result success.
 * @throws {WebError} with code `MALFORMED_RESPONSE` when the body is not an
 *   object, when `candidates` is present with a non-array value, when a
 *   candidate is present but yields neither answer text nor usable sources,
 *   or when `groundingChunks` is present with a non-array value.
 */
export function normalizeGeminiSearchResponse(body: unknown): WebSearchResult {
	if (!isPlainObject(body)) {
		throw malformed("response body must be a JSON object");
	}
	const candidates = body["candidates"];
	// Absent `candidates` is a valid zero-result response (the model produced
	// nothing); present-but-not-an-array is malformed.
	if (candidates !== undefined && !Array.isArray(candidates)) {
		throw malformed("response 'candidates' must be an array when present");
	}

	const candidate = candidates !== undefined && candidates.length > 0 ? candidates[0] : undefined;

	// A candidate that is present but yields nothing usable is malformed —
	// we expected at least an answer or a source and got neither. An *absent*
	// or *empty* `candidates` is a legitimate "no results" success.
	let content: string | undefined;
	let sources: WebSearchSource[] = [];
	if (candidate !== undefined) {
		if (!isPlainObject(candidate)) {
			throw malformed("response 'candidates[0]' must be an object");
		}
		content = extractAnswerText(candidate);
		sources = extractGroundingSources(candidate);
		if (content === undefined && sources.length === 0) {
			throw malformed("response 'candidates[0]' contained neither answer text nor usable grounding sources");
		}
	}

	// `truncated` is false because the DSH seam owns truncation.
	const result: { sources: WebSearchSource[]; truncated: boolean; content?: string } = {
		sources,
		truncated: false
	};
	if (content !== undefined) {
		result.content = content;
	}
	return result as WebSearchResult;
}

/**
 * Extract the provider-generated answer text from a candidate: the
 * concatenation of the `text` fields of `content.parts[]`, in order. Parts
 * without a `text` field (for example `thoughtSignature`-only parts) are
 * skipped. Returns `undefined` when there is no answer text.
 */
function extractAnswerText(candidate: Record<string, unknown>): string | undefined {
	const content = candidate["content"];
	if (!isPlainObject(content)) {
		return undefined;
	}
	const parts = content["parts"];
	if (parts === undefined) {
		return undefined;
	}
	if (!Array.isArray(parts)) {
		throw malformed("candidate 'content.parts' must be an array when present");
	}
	const texts: string[] = [];
	for (const part of parts) {
		if (isPlainObject(part)) {
			const text = part["text"];
			if (typeof text === "string" && text.trim().length > 0) {
				texts.push(text);
			}
		}
	}
	if (texts.length === 0) {
		return undefined;
	}
	const joined = texts.join("").trim();
	return joined.length > 0 ? joined : undefined;
}

/**
 * Extract the grounding sources from a candidate's `groundingMetadata`.
 *
 * A chunk maps to a seam source when its `web.uri` is a usable (non-blank
 * string) URL; `web.title` maps to `title` when non-blank. Chunks without a
 * usable `uri` are dropped (not an error — a few unusable chunks among
 * usable ones is tolerable). Sources are deduplicated by exact URL
 * (first occurrence wins), preserving grounding order.
 *
 * `groundingMetadata` absent (or without `groundingChunks`) is a legitimate
 * zero-source result. A `groundingChunks` field that is *present* but not an
 * array, or present and non-empty but with no usable chunk, is malformed.
 */
function extractGroundingSources(candidate: Record<string, unknown>): WebSearchSource[] {
	const metadata = candidate["groundingMetadata"];
	if (metadata === undefined) {
		return [];
	}
	if (!isPlainObject(metadata)) {
		throw malformed("candidate 'groundingMetadata' must be an object when present");
	}
	const chunks = metadata["groundingChunks"];
	// Absent `groundingChunks` is a valid zero-source response (no grounding);
	// present-but-not-an-array is malformed.
	if (chunks !== undefined && !Array.isArray(chunks)) {
		throw malformed("response 'groundingChunks' must be an array when present");
	}
	if (chunks === undefined) {
		return [];
	}

	const sources: WebSearchSource[] = [];
	const seenUrls = new Set<string>();
	for (const chunk of chunks) {
		const source = normalizeGroundingChunk(chunk);
		if (source !== undefined && !seenUrls.has(source.url)) {
			seenUrls.add(source.url);
			sources.push(source);
		}
	}

	// A response that carried chunks but none of them usable is malformed —
	// we expected at least one source and got none.
	if (chunks.length > 0 && sources.length === 0) {
		throw malformed("response 'groundingChunks' contained no usable grounding source");
	}
	return sources;
}

/**
 * Map a single `groundingChunks[]` entry to a seam {@link WebSearchSource},
 * or return `undefined` when the entry has no usable `web.uri` (it is
 * dropped, not an error).
 *
 * Optional fields are preserved exactly as the seam defines them: a missing
 * or blank `title` stays **absent** (never defaulted to `""`), and
 * `snippet`/`publishedAt` are never synthesized (the grounding response
 * supplies neither).
 */
function normalizeGroundingChunk(chunk: unknown): WebSearchSource | undefined {
	if (!isPlainObject(chunk)) {
		return undefined;
	}
	const web = chunk["web"];
	if (!isPlainObject(web)) {
		return undefined;
	}
	const url = asNonEmptyString(web["uri"]);
	if (url === undefined) {
		return undefined;
	}
	const title = asNonEmptyString(web["title"]);

	const source: { url: string; title?: string } = { url };
	if (title !== undefined) {
		source.title = title;
	}
	return source;
}

/**
 * Read a string field, trimming surrounding whitespace; return `undefined`
 * when the value is not a string or is empty/whitespace-only (treated as
 * absent). A non-blank value is returned trimmed — normalization, not
 * invention.
 */
function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** A JSON object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the structured `WebError` for an unusable Gemini response. */
function malformed(message: string): WebError {
	return new WebError(message, GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE);
}
