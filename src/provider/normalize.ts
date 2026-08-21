/**
 * Google Custom Search response → DSH seam result normalization (Issue #3).
 *
 * This is a **Google-adapter-owned** helper: it is the only place in the
 * plugin that knows Google's wire field names (`items`, `link`, `title`,
 * `snippet`). It translates a parsed Google Custom Search JSON API response
 * into the stable, provider-neutral seam types from `@deepseek-ai/dsh-web`
 * (`WebSearchResult` / `WebSearchSource`). It does **not** define a parallel
 * result type and does **not** close any contract: the DSH seam types are the
 * contract, imported here.
 *
 * Field mapping (Google → seam):
 *   - `link`    → `url`       (required; an item without a usable `link` is dropped)
 *   - `title`   → `title`     (optional; absent when Google omits it or it is blank)
 *   - `snippet` → `snippet`   (optional; absent when Google omits it or it is blank)
 *
 * Fields the seam defines but Google does **not** supply are left **absent**,
 * never invented:
 *   - `publishedAt` — Google Custom Search JSON does not reliably provide a
 *     publication date, so it is never synthesized.
 *   - `content`     — there is no aggregate content in the response, so the
 *     result carries no `content`.
 *
 * `truncated` is owned by the DSH seam, which enforces `maxResults` on the way
 * back and sets the flag itself. This helper therefore always reports
 * `truncated: false` and does **not** apply any limit — duplicating the seam's
 * truncation would double-count it.
 *
 * A response that cannot be mapped onto the seam shape is a *malformed
 * response*, not a silent success: it throws a `WebError` with the
 * `MALFORMED_RESPONSE` code (see {@link ./errors.js}). Per ENGINEERING.md §7
 * a failure is never hidden behind a success-shaped result.
 *
 * **Absent is not malformed** (ENGINEERING.md §2): Google omits the optional
 * `items` field entirely when there are no results, so a valid object
 * response *without* `items` is a legitimate zero-result success. Only an
 * `items` field that is *present* with a non-array value is malformed —
 * the distinction between *absent* and *malformed concrete value* is
 * preserved, not collapsed.
 */

import { WebError, type WebSearchResult, type WebSearchSource } from "@deepseek-ai/dsh-web";
import { GOOGLE_SEARCH_ERROR_CODES } from "./errors.js";

/**
 * Normalize a parsed Google Custom Search JSON API response body into a DSH
 * seam {@link WebSearchResult}.
 *
 * @param body - the parsed JSON body of a successful (2xx) Google response.
 *   Error bodies (rate limit, auth, 5xx) are classified by the transport layer
 *   before this helper is reached and are not malformed responses.
 * @returns a `WebSearchResult` whose `sources` preserve Google's result order,
 *   with `truncated: false` (the seam owns truncation) and no `content`. An
 *   object response whose `items` field is absent (Google omits it when there
 *   are no results) or empty is a legitimate zero-result success.
 * @throws {WebError} with code `MALFORMED_RESPONSE` when the body is not an
 *   object, when `items` is present with a non-array value, or when `items`
 *   is present and non-empty but contains no usable result.
 */
export function normalizeGoogleSearchResponse(body: unknown): WebSearchResult {
	if (!isPlainObject(body)) {
		throw malformed("response body must be a JSON object");
	}
	const items = body["items"];
	// Absent `items` is a valid zero-result response (Google omits the field
	// when there are no results); present-but-not-an-array is malformed.
	if (items !== undefined && !Array.isArray(items)) {
		throw malformed("response 'items' must be an array when present");
	}

	const entries = items === undefined ? [] : items;
	const sources: WebSearchSource[] = [];
	for (const item of entries) {
		const source = normalizeGoogleItem(item);
		if (source !== undefined) {
			sources.push(source);
		}
	}

	// A response that carried items but none of them usable is malformed —
	// we expected at least one source and got none. An *absent* or *empty*
	// `items` is a legitimate "no results" success and yields zero sources.
	if (entries.length > 0 && sources.length === 0) {
		throw malformed("response 'items' contained no usable search result");
	}

	// `content` is intentionally absent (Google provides no aggregate content);
	// `truncated` is false because the DSH seam owns truncation.
	return { sources, truncated: false };
}

/**
 * Map a single Google `items[]` entry to a seam {@link WebSearchSource}, or
 * return `undefined` when the entry has no usable `link` (it is dropped, not
 * an error — a few unusable entries among usable ones is tolerable).
 *
 * Optional fields are preserved exactly as the seam defines them: a missing or
 * blank `title`/`snippet` stays **absent** (never defaulted to `""`), and
 * `publishedAt` is never synthesized.
 */
function normalizeGoogleItem(item: unknown): WebSearchSource | undefined {
	if (!isPlainObject(item)) {
		return undefined;
	}
	const url = asNonEmptyString(item["link"]);
	if (url === undefined) {
		return undefined;
	}
	const title = asNonEmptyString(item["title"]);
	const snippet = asNonEmptyString(item["snippet"]);

	const source: { url: string; title?: string; snippet?: string } = { url };
	if (title !== undefined) {
		source.title = title;
	}
	if (snippet !== undefined) {
		source.snippet = snippet;
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

/** Build the structured `WebError` for an unusable Google response. */
function malformed(message: string): WebError {
	return new WebError(message, GOOGLE_SEARCH_ERROR_CODES.MALFORMED_RESPONSE);
}
