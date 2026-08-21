/**
 * Normalized result semantics and ordering (Issue #3).
 *
 * The provider adapter (Issue #4) extracts fields from the provider's
 * response into a minimal raw shape — one object per returned item with
 * optional `url`, `title`, `snippet`, and `source` — and hands it to
 * {@link normalizeSearchResults}. The normalizer enforces the domain result
 * contract on that handoff:
 *
 * - a result always has a non-empty `url`; items without one are not
 *   results and are dropped;
 * - `title`, `snippet`, and `source` are included only when the provider
 *   supplied a non-empty string; empty strings are treated as *absent*, so
 *   the adapter never has to invent values (ENGINEERING.md §2);
 * - ordering is exactly the provider's returned order — no reordering,
 *   scoring, or reranking happens here (Issue #3 non-goals);
 * - an empty provider list is a valid empty outcome; a non-empty list from
 *   which no usable result survives is a `malformed_response` error, so a
 *   broken response is never hidden behind an empty success
 *   (ENGINEERING.md §7).
 *
 * The caller's `limit`, when present, is applied last: results beyond it
 * are dropped and `truncated` is set to `true`.
 */

import { SearchError } from "./errors.js";
import type { SearchOutcome, SearchResult } from "./types.js";

/**
 * One raw result item as handed off by a provider adapter: the fields the
 * adapter extracted from the provider response, before the domain contract
 * is enforced. Every field is optional at this stage; the normalizer
 * decides what a result may keep.
 */
export type RawSearchResult = Record<string, unknown>;

/**
 * Normalize a provider's raw result list into a {@link SearchOutcome}.
 *
 * @param rawResults - the provider's result list (any JSON value; validated
 *   here). Must be an array of objects.
 * @param limit - the caller's result-count bound, when one was requested.
 * @throws {SearchError} with code `malformed_response` when `rawResults` is
 *   not an array, or when a non-empty list yields no usable result.
 */
export function normalizeSearchResults(rawResults: unknown, limit?: number): SearchOutcome {
	if (!Array.isArray(rawResults)) {
		throw new SearchError(
			"malformed_response",
			"provider response: expected a list of results, got a non-array value"
		);
	}

	const results: SearchResult[] = [];
	for (const item of rawResults) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const record = item as RawSearchResult;

		const url = record["url"];
		if (typeof url !== "string" || url.trim().length === 0) continue;

		const result: SearchResult = { url: url.trim() };
		const title = record["title"];
		if (typeof title === "string" && title.trim().length > 0) result.title = title.trim();
		const snippet = record["snippet"];
		if (typeof snippet === "string" && snippet.trim().length > 0) result.snippet = snippet.trim();
		const source = record["source"];
		if (typeof source === "string" && source.trim().length > 0) result.source = source.trim();
		results.push(result);
	}

	if (rawResults.length > 0 && results.length === 0) {
		throw new SearchError(
			"malformed_response",
			`provider response: ${rawResults.length} result item(s) but none carried a usable url`
		);
	}

	const usableCount = results.length;
	const bounded = limit !== undefined ? results.slice(0, limit) : results;
	return Object.freeze({
		results: Object.freeze(bounded),
		truncated: limit !== undefined && usableCount > limit
	});
}
