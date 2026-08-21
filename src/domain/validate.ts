/**
 * Validated provider-neutral input semantics (Issue #3).
 *
 * {@link validateSearchQuery} is the single entry point that turns an
 * untrusted input (for example parsed tool arguments) into a
 * {@link SearchQuery}. It throws a structured {@link SearchError} with code
 * `invalid_request` on the first violation it reports; it never throws
 * unstructured errors and never returns a partially-validated value.
 *
 * Unknown input fields are projected away: the domain owns its field set,
 * and extra fields are neither accepted into the domain nor treated as
 * errors. This is deliberate — the tool layer's parameter schema is an open
 * object, and a stray field is not a request failure.
 */

import { SearchError } from "./errors.js";
import type { SearchQuery } from "./types.js";

/** An untrusted input candidate for a {@link SearchQuery}. */
export type SearchQueryInput = Record<string, unknown>;

/**
 * Validate `input` into a {@link SearchQuery}.
 *
 * Rules (all violations are `invalid_request`):
 * - `input` must be a plain object (not `null`, not an array).
 * - `query` is required: a string that is non-empty after trimming. The
 *   stored value is the trimmed string.
 * - `limit`, when present, must be a positive integer. Absent stays absent.
 * - `language` and `region`, when present, must be non-empty strings after
 *   trimming; the stored value is the trimmed string. Absent stays absent.
 * - `safeSearch`, when present, must be exactly `true` or `false`. Absent
 *   stays absent — it is never defaulted.
 *
 * @throws {SearchError} with code `invalid_request` and a message naming
 *   every violated field.
 */
export function validateSearchQuery(input: unknown): SearchQuery {
	const violations: string[] = [];

	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new SearchError("invalid_request", "search query must be an object");
	}
	const record = input as SearchQueryInput;

	// query — required, non-empty after trim.
	const query = record["query"];
	if (typeof query !== "string") {
		violations.push("query is required and must be a string");
	} else if (query.trim().length === 0) {
		violations.push("query must be a non-empty string");
	}

	// limit — optional positive integer; absent stays absent.
	let limit: number | undefined;
	if (record["limit"] !== undefined) {
		const value = record["limit"];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
			violations.push("limit, when present, must be a positive integer");
		} else {
			limit = value;
		}
	}

	// language / region — optional non-empty strings; absent stays absent.
	let language: string | undefined;
	if (record["language"] !== undefined) {
		const value = record["language"];
		if (typeof value !== "string" || value.trim().length === 0) {
			violations.push("language, when present, must be a non-empty string");
		} else {
			language = value.trim();
		}
	}
	let region: string | undefined;
	if (record["region"] !== undefined) {
		const value = record["region"];
		if (typeof value !== "string" || value.trim().length === 0) {
			violations.push("region, when present, must be a non-empty string");
		} else {
			region = value.trim();
		}
	}

	// safeSearch — optional strict boolean; absent stays absent.
	let safeSearch: boolean | undefined;
	if (record["safeSearch"] !== undefined) {
		const value = record["safeSearch"];
		if (typeof value !== "boolean") {
			violations.push("safeSearch, when present, must be a boolean");
		} else {
			safeSearch = value;
		}
	}

	if (violations.length > 0) {
		throw new SearchError("invalid_request", `invalid search query: ${violations.join("; ")}`);
	}

	const result: SearchQuery = { query: (query as string).trim() };
	if (limit !== undefined) result.limit = limit;
	if (language !== undefined) result.language = language;
	if (region !== undefined) result.region = region;
	if (safeSearch !== undefined) result.safeSearch = safeSearch;
	return Object.freeze(result);
}
