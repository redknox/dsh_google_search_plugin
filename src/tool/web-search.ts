/**
 * The model-facing `web_search` tool (Issue #2).
 *
 * Registered through `defineTool` from `@deepseek-ai/dsh-tools` — a public
 * Harness extension contract. The tool's input and output use the
 * provider-neutral search domain (Issue #3): no Google-specific wire field
 * appears in the parameter or output schema (ENGINEERING.md §1).
 *
 * Execution state for this issue: no search backend is wired yet (Issue #4
 * adds the Google adapter, Issue #5 wires it into this tool). A call
 * therefore never reaches a provider; it fails with a structured
 * {@link SearchError} of code `capability_unavailable` — an explicit,
 * machine-routable "no usable search provider" failure, never a
 * success-shaped result (ENGINEERING.md §7).
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SearchError, validateSearchQuery } from "../domain/index.js";

/** The stable, user-facing tool name. */
export const WEB_SEARCH_TOOL_NAME = "web_search";

/**
 * Build the `web_search` tool definition. Pure: no services are touched
 * here, so the definition is inspectable and testable in isolation.
 */
export function buildWebSearchTool() {
	return defineTool({
		name: WEB_SEARCH_TOOL_NAME,
		description:
			"Search the web for current information. Provide a single search query; optionally bound the result count and express language, region, and safe-search preferences. Returns a list of citeable sources (url, and title/snippet/source when the search backend supplies them).",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Required search query text."
			},
			limit: {
				type: "integer",
				description: "Optional upper bound on the number of returned results (positive integer)."
			},
			language: {
				type: "string",
				description: "Optional preferred result language, as a language tag (for example \"en\")."
			},
			region: {
				type: "string",
				description: "Optional preferred result region, as a region code (for example \"us\")."
			},
			safeSearch: {
				type: "boolean",
				description: "Optional explicit safe-search preference."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					results: {
						type: "array",
						required: true,
						description: "Citeable sources in the provider's returned order.",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								url: {
									type: "string",
									required: true,
									description: "The result URL."
								},
								title: {
									type: "string",
									description: "Display title, when the backend returns one."
								},
								snippet: {
									type: "string",
									description: "Result snippet, when the backend returns one."
								},
								source: {
									type: "string",
									description: "Source identifier, when the backend reports one."
								}
							}
						}
					},
					truncated: {
						type: "boolean",
						required: true,
						description: "True only when results were dropped to honor the requested limit."
					}
				}
			},
			render: (_args, value) => {
				const block: ContentBlock = { type: "text", text: formatSearchOutput(value) };
				return [block];
			}
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			// Structural validation already happened in defineTool's wrapper;
			// this is the domain's semantic validation (Issue #3).
			validateSearchQuery(args);
			// No search backend is wired yet (Issues #4/#5). Fail with the
			// explicit capability-unavailable category — never a success.
			throw new SearchError(
				"capability_unavailable",
				"web_search is registered but no search backend is wired into this deployment yet"
			);
		}
	});
}

/**
 * Render one canonical `web_search` value as model-facing text. Pure
 * projection; the registry owns everything else about the result.
 */
function formatSearchOutput(value: {
	results: readonly { url: string; title?: string; snippet?: string; source?: string }[];
	truncated: boolean;
}): string {
	if (value.results.length === 0) return "No search results.";
	const lines = value.results.map((r, i) => {
		const head = r.title !== undefined ? `${i + 1}. ${r.title}` : `${i + 1}. ${r.url}`;
		const parts = [head];
		if (r.title !== undefined) parts.push(`   ${r.url}`);
		if (r.snippet !== undefined) parts.push(`   ${r.snippet}`);
		return parts.join("\n");
	});
	const tail = value.truncated ? "\n\n(Results truncated to the requested limit.)" : "";
	return `Search results:\n${lines.join("\n")}${tail}`;
}
