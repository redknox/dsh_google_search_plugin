/**
 * Gemini `google_search` grounding response → DSH seam result normalization
 * (Issue #7 migration, re-review compliance pass).
 *
 * This is a **Google-adapter-owned** helper: it is the only place in the
 * plugin that knows the Gemini wire field names (`candidates`, `parts`,
 * `text`, `groundingMetadata`, `groundingChunks`, `web`, `uri`, `title`,
 * `groundingSupports`, `webSearchQueries`). It translates a parsed Gemini API
 * `generateContent` response (with the `google_search` tool) into the stable,
 * provider-neutral seam types from `@deepseek-ai/dsh-web`
 * (`WebSearchResult` / `WebSearchSource`). It does **not** define a parallel
 * result type and does **not** close any contract: the DSH seam types are the
 * contract, imported here.
 *
 * **What the grounding API returns — and what that means for the mapping.**
 * Google documents `google_search` grounding as a *generated grounded
 * response with associated Search Suggestions and citations*, not as a
 * replacement SERP API. Concretely, the wire response carries:
 *
 *   - the model's synthesized answer (`candidates[0].content.parts[].text`);
 *   - `groundingMetadata.groundingChunks[]` — the *evidence* the model used
 *     (a web URI + title per chunk). These are evidence for the generated
 *     answer, **not documented ranked search results**: no Google contract
 *     establishes the chunk order as a SERP ranking, so nothing here claims
 *     it;
 *   - `groundingMetadata.groundingSupports[]` — the citation relationship:
 *     which segments of the answer are supported by which chunks;
 *   - `groundingMetadata.webSearchQueries[]` — the queries the model ran,
 *     i.e. the basis for the Search Suggestions Google's display terms
 *     require to accompany grounded results.
 *
 * The DSH seam types have no dedicated fields for the citation relationship
 * or the Search Suggestions. Rather than discarding them (which would leave
 * the runtime without a compliant presentation path and would separate the
 * answer from its citations), this adapter preserves the grounded artifact
 * **end to end through the fields the seam does have**:
 *
 *   - `content` = the answer with **inline citation markers** `[n]` appended
 *     after each cited segment (1-based `n` into the `sources` array, which
 *     the DSH tool renders immediately after `content` as its "Sources:"
 *     list — so the markers resolve against the list the end user sees),
 *     followed by a **Search suggestions** section carrying one Google
 *     search link per `webSearchQueries` entry. The answer, its citations,
 *     and the Search Suggestions therefore reach the end user together.
 *   - `sources` = the grounding chunks (deduplicated by exact URL, first
 *     occurrence wins), in the order the response carries them. The order is
 *     *response order*, not a claimed ranking.
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
 * seam's truncation would double-count it. Citation markers are, however,
 * clamped to the seam's `maxResults` bound (when the request carries one):
 * a marker pointing at a source the seam will truncate would dangle, so
 * only sources the seam is guaranteed to keep are cited.
 *
 * A response that cannot be mapped onto the seam shape is a *malformed
 * response*, not a silent success: it throws a `WebError` with the
 * `MALFORMED_RESPONSE` code (see {@link ./errors.js}). Per ENGINEERING.md §7
 * a failure is never hidden behind a success-shaped result.
 *
 * **Absent is not malformed, and absent is not "zero search results"**
 * (ENGINEERING.md §2, §5): Gemini omits `groundingMetadata` entirely when it
 * produced no grounding for the response. That is the wire fact — *zero
 * grounding sources*. It is **not** observable from the wire that Google
 * Search executed and found zero results (the model may decline to search or
 * answer without attaching grounding), so this helper — and the evidence
 * recorded for it — states "zero grounding sources", never "Google returned
 * zero search results". Only a `groundingChunks` field that is *present* with
 * a non-array value, or a candidate that is present but yields neither answer
 * text nor usable sources, is malformed — the distinction between *absent*
 * and *malformed concrete value* is preserved, not collapsed.
 */

import { WebError, type WebSearchResult, type WebSearchSource } from "@deepseek-ai/dsh-web";
import { GOOGLE_SEARCH_ERROR_CODES } from "./errors.js";

/** The label the Search-suggestions section in `content` carries. */
export const GEMINI_SEARCH_SUGGESTIONS_LABEL = "Search suggestions:";

/** Build the Google search URL for one grounded search query. */
export function buildGoogleSearchSuggestionUrl(query: string): string {
	return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
}

/**
 * Normalize a parsed Gemini API `generateContent` response body (with the
 * `google_search` tool) into a DSH seam {@link WebSearchResult}.
 *
 * @param body - the parsed JSON body of a successful (2xx) Gemini response.
 *   Error bodies (auth, rate limit, 5xx) are classified by the transport
 *   layer before this helper is reached and are not malformed responses.
 * @param maxResults - the seam's per-request result bound, when the request
 *   carries one. Used only to clamp citation markers to the sources the seam
 *   is guaranteed to keep (the seam itself performs the truncation).
 * @returns a `WebSearchResult` whose `sources` preserve the response's
 *   grounding-chunk order (deduplicated by exact URL — response order, not a
 *   claimed ranking), with `truncated: false` (the seam owns truncation) and
 *   the grounded answer — inline citation markers plus the Search
 *   suggestions — as `content` when present. A response without
 *   `candidates`, or with no `groundingMetadata` (zero grounding sources),
 *   is a legitimate zero-source success.
 * @throws {WebError} with code `MALFORMED_RESPONSE` when the body is not an
 *   object, when `candidates` is present with a non-array value, when a
 *   candidate is present but yields neither answer text nor usable sources,
 *   or when `groundingChunks` is present with a non-array value.
 */
export function normalizeGeminiSearchResponse(
	body: unknown,
	maxResults?: number
): WebSearchResult {
	if (!isPlainObject(body)) {
		throw malformed("response body must be a JSON object");
	}
	const candidates = body["candidates"];
	// Absent `candidates` is a valid zero-source response (the model produced
	// nothing); present-but-not-an-array is malformed.
	if (candidates !== undefined && !Array.isArray(candidates)) {
		throw malformed("response 'candidates' must be an array when present");
	}

	const candidate = candidates !== undefined && candidates.length > 0 ? candidates[0] : undefined;

	// A candidate that is present but yields nothing usable is malformed —
	// we expected at least an answer or a source and got neither. An *absent*
	// or *empty* `candidates` is a legitimate zero-source success.
	let content: string | undefined;
	let sources: WebSearchSource[] = [];
	if (candidate !== undefined) {
		if (!isPlainObject(candidate)) {
			throw malformed("response 'candidates[0]' must be an object");
		}
		const answer = extractAnswerText(candidate);
		sources = extractGroundingSources(candidate);
		content = buildGroundedContent(candidate, answer, sources, maxResults);
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
 * Assemble the grounded `content`: the answer with inline citation markers
 * (from `groundingSupports`) and the Search suggestions (from
 * `webSearchQueries`) appended. Returns `undefined` when there is no answer
 * text and no suggestions (a sources-only response keeps `content` absent,
 * matching the seam's optional-field discipline).
 */
function buildGroundedContent(
	candidate: Record<string, unknown>,
	answer: string | undefined,
	sources: WebSearchSource[],
	maxResults: number | undefined
): string | undefined {
	const metadata = candidate["groundingMetadata"];
	const supports = isPlainObject(metadata) ? metadata["groundingSupports"] : undefined;
	const rawQueries = isPlainObject(metadata) ? metadata["webSearchQueries"] : undefined;
	const queries = Array.isArray(rawQueries)
		? rawQueries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
		: [];

	if (answer === undefined && queries.length === 0) {
		return undefined;
	}

	// The seam keeps at most `maxResults` sources (when the request carries a
	// bound); cite only sources it is guaranteed to keep.
	const visibleCount =
		typeof maxResults === "number" && maxResults > 0 ? Math.min(sources.length, maxResults) : sources.length;

	const text = answer ?? "";
	const marked =
		Array.isArray(supports) && visibleCount > 0
			? insertCitationMarkers(text, supports, visibleCount, buildChunkToSourceMap(candidate))
			: text;

	const parts: string[] = [];
	if (marked.length > 0) {
		parts.push(marked);
	}
	if (queries.length > 0) {
		const lines = queries.map((q) => `- [${q.trim()}](${buildGoogleSearchSuggestionUrl(q)})`);
		parts.push(`${GEMINI_SEARCH_SUGGESTIONS_LABEL}\n${lines.join("\n")}`);
	}
	const joined = parts.join("\n\n").trim();
	return joined.length > 0 ? joined : undefined;
}

/**
 * Build the chunk-index → source-index mapping for citation markers, using
 * exactly the dedup rule {@link extractGroundingSources} applies (usable
 * `web.uri` only, first occurrence wins, response order preserved). A chunk
 * that duplicated an earlier URL maps to the *first* source — the one the
 * end user sees. Chunks without a usable URL map to nothing.
 */
function buildChunkToSourceMap(candidate: Record<string, unknown>): Map<number, number> {
	const mapping = new Map<number, number>();
	const metadata = candidate["groundingMetadata"];
	if (!isPlainObject(metadata) || !Array.isArray(metadata["groundingChunks"])) {
		return mapping;
	}
	const urlToSource = new Map<string, number>();
	let sourceIndex = 0;
	for (let i = 0; i < (metadata["groundingChunks"] as unknown[]).length; i++) {
		const url = chunkUrl((metadata["groundingChunks"] as unknown[])[i]);
		if (url === undefined) {
			continue;
		}
		const existing = urlToSource.get(url);
		if (existing !== undefined) {
			// A duplicate chunk cites the first source (the one the end user
			// sees), not a second entry.
			mapping.set(i, existing);
		} else {
			urlToSource.set(url, sourceIndex);
			mapping.set(i, sourceIndex);
			sourceIndex += 1;
		}
	}
	return mapping;
}

/** The usable `web.uri` of a grounding chunk, or `undefined`. */
function chunkUrl(chunk: unknown): string | undefined {
	if (!isPlainObject(chunk)) {
		return undefined;
	}
	const web = chunk["web"];
	return isPlainObject(web) ? asNonEmptyString(web["uri"]) : undefined;
}

/**
 * Insert inline citation markers into the answer text from
 * `groundingSupports[]`.
 *
 * Each support names an answer segment (`segment.text`, with
 * `startIndex`/`endIndex` offsets into the answer) and the
 * `groundingChunkIndices` that back it. The marker `[n]` (1-based `n` into
 * the deduplicated `sources` array) is appended after the segment's text.
 *
 * Rules (defensive; the wire shape has no strict contract):
 *   - chunk indices are mapped through `chunkToSource` (the dedup rule);
 *   - indices whose source is at or beyond `visibleCount` (sources the seam
 *     will truncate) are dropped; a support left with no visible citation is
 *     skipped;
 *   - the segment is located at its wire offsets (`startIndex`/`endIndex`)
 *     when those are consistent with the answer, otherwise with `indexOf`
 *     from a moving cursor; a segment that cannot be found (the model
 *     paraphrased it) is skipped — best effort, never an error;
 *   - supports whose segments share an insertion point are merged (union of
 *     visible chunk indices) so overlapping/nested segments do not stack
 *     markers;
 *   - markers are sorted ascending within each insertion point.
 */
function insertCitationMarkers(
	answer: string,
	supports: unknown[],
	visibleCount: number,
	chunkToSource: Map<number, number>
): string {
	interface Marker {
		indices: Set<number>;
	}
	const markers = new Map<number, Marker>();
	let cursor = 0;
	const ordered = [...supports]
		.filter((s): s is Record<string, unknown> => isPlainObject(s))
		.map((s) => {
			const segment = s["segment"];
			return {
				segment: isPlainObject(segment) ? segment : undefined,
				indices: Array.isArray(s["groundingChunkIndices"]) ? (s["groundingChunkIndices"] as unknown[]) : []
			};
		})
		.filter((s) => s.segment !== undefined && typeof s.segment["text"] === "string")
		.sort((a, b) => ((a.segment?.["startIndex"] as number) ?? 0) - ((b.segment?.["startIndex"] as number) ?? 0));

	for (const { segment, indices } of ordered) {
		const seg = segment as Record<string, unknown>;
		const text = seg["text"] as string;
		if (text.trim().length === 0) {
			continue;
		}
		// Prefer the wire's own offsets when they are consistent with the
		// answer (they are the model's exact segment boundaries); fall back
		// to locating the segment text from a moving cursor otherwise.
		let found = -1;
		const startIndex = seg["startIndex"];
		const endIndex = seg["endIndex"];
		if (
			typeof startIndex === "number" &&
			typeof endIndex === "number" &&
			startIndex >= 0 &&
			endIndex >= startIndex &&
			endIndex <= answer.length &&
			typeof answer[startIndex] === "string" &&
			answer.slice(startIndex, endIndex) === text
		) {
			found = startIndex;
		} else {
			found = answer.indexOf(text, cursor);
		}
		if (found < 0) {
			continue; // the model paraphrased this segment; skip best-effort
		}
		cursor = found + text.length;
		const visible = new Set<number>();
		for (const raw of indices) {
			if (typeof raw !== "number" || raw < 0) {
				continue;
			}
			const sourceIndex = chunkToSource.get(raw);
			if (sourceIndex === undefined || sourceIndex >= visibleCount) {
				continue;
			}
			visible.add(sourceIndex + 1); // 1-based into the sources array
		}
		if (visible.size === 0) {
			continue;
		}
		const existing = markers.get(cursor);
		if (existing) {
			for (const n of visible) existing.indices.add(n);
		} else {
			markers.set(cursor, { indices: visible });
		}
	}

	if (markers.size === 0) {
		return answer;
	}
	// Insert from the end so earlier positions stay valid.
	let out = answer;
	const positions = [...markers.keys()].sort((a, b) => b - a);
	for (const position of positions) {
		const { indices } = markers.get(position)!;
		const marker = `[${[...indices].sort((a, b) => a - b).join(", ")}]`;
		out = out.slice(0, position) + marker + out.slice(position);
	}
	return out;
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
 * (first occurrence wins), preserving the response's chunk order — which is
 * the order the model attached its evidence, **not** a claimed SERP ranking.
 *
 * `groundingMetadata` absent (or without `groundingChunks`) is a legitimate
 * zero-source result (zero grounding sources; the wire does not say whether
 * a search ran and found nothing). A `groundingChunks` field that is
 * *present* but not an array, or present and non-empty but with no usable
 * chunk, is malformed.
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
