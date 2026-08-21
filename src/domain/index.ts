/**
 * Provider-neutral search domain (Issue #3): types, validated input
 * semantics, normalized result semantics, and stable error categories.
 *
 * Nothing in this module touches a provider wire format or a transport; it
 * is the internal contract the provider adapter (Issue #4) maps onto and
 * the tool layer (Issue #2) consumes.
 */

export {
	SEARCH_ERROR_CODES,
	SearchError,
	isSearchError,
	type SearchErrorCode
} from "./errors.js";
export {
	normalizeSearchResults,
	type RawSearchResult
} from "./normalize.js";
export {
	validateSearchQuery,
	type SearchQueryInput
} from "./validate.js";
export type {
	SearchOutcome,
	SearchQuery,
	SearchResult
} from "./types.js";
