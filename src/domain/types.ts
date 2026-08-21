/**
 * Provider-neutral search domain contract (Issue #3).
 *
 * This module is the plugin's internal search domain. Per ENGINEERING.md §1
 * it MUST NOT contain any specific search provider's field names, endpoints,
 * or error codes: a Google wire field may appear only inside the provider
 * adapter (Issue #4), which maps its responses onto the types below.
 *
 * Required vs optional is explicit (ENGINEERING.md §2): an optional field
 * left `undefined` means *absent* — the caller did not specify it, or the
 * provider did not return it. Absent is never coerced to `false`, a default,
 * or any other concrete value.
 */

/**
 * A validated, provider-neutral search request.
 *
 * `query` is the only required field. `limit`, `language`, `region`, and
 * `safeSearch` are optional; their absence means "not specified" and is
 * preserved as such through validation and normalization.
 */
export interface SearchQuery {
	/** The search query text. Required; non-empty after validation. */
	query: string;
	/**
	 * Upper bound on the number of returned results, when the caller asks for
	 * one. A positive integer. Absent means the caller set no bound.
	 */
	limit?: number;
	/**
	 * Preferred result language, as a provider-independent language tag
	 * (for example `"en"`). Absent means no preference was expressed.
	 */
	language?: string;
	/**
	 * Preferred result region, as a provider-independent region code
	 * (for example `"us"`). Absent means no preference was expressed.
	 */
	region?: string;
	/**
	 * Explicit safe-search preference. Absent means the caller did not
	 * specify one; it is never defaulted to `false`.
	 */
	safeSearch?: boolean;
}

/**
 * One normalized search result.
 *
 * A result always has a `url`. `title`, `snippet`, and `source` are
 * optional and remain `undefined` when the provider does not supply them —
 * adapters MUST NOT invent values to fill them (ENGINEERING.md §2).
 */
export interface SearchResult {
	/** The result URL. Required. */
	url: string;
	/** Display title, when the provider returns one. */
	title?: string;
	/** Result snippet/summary, when the provider returns one. */
	snippet?: string;
	/** Identifies the source the result came from, when the provider reports one. */
	source?: string;
}

/**
 * A normalized search outcome: results in the provider's returned order.
 *
 * `results` is always present (possibly empty). `truncated` is `true` only
 * when the caller's `limit` dropped results that the provider did return;
 * it is `false` (not absent) when no bound was applied or nothing was
 * dropped, so the absence of truncation is an explicit fact.
 */
export interface SearchOutcome {
	/** Normalized results, in the provider's returned order. */
	results: readonly SearchResult[];
	/** `true` only when results were dropped to honor the caller's `limit`. */
	truncated: boolean;
}
