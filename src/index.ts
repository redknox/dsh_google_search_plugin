/**
 * DSH plugin entry (Issue #2).
 *
 * Registers the provider-neutral `web_search` tool through public DSH
 * extension contracts only — the Cordis `Context` and the `tools` /
 * `systemPrompt` services — with no Agent Loop internals and no private
 * imports (Issue #2 acceptance).
 *
 * Lifecycle: both registrations are fiber-scoped effects. Cordis disposes
 * them automatically when the plugin's fiber unloads, so no manual teardown
 * is required (the same lifecycle the reference `dsh-tool-web` plugin
 * relies on).
 *
 * NOTE (architecture conflict, flagged for review): the committed
 * ARCHITECTURE.md/README.md describe a provider-only plugin (no new
 * model-facing tool). Per the maintainer's decision for this round, the
 * plugin registers its own `web_search` tool as Issue #2 literally
 * specifies; the docs need a post-review revision to match.
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";
import { buildWebSearchTool, WEB_SEARCH_TOOL_NAME } from "./tool/web-search.js";

export { WEB_SEARCH_TOOL_NAME } from "./tool/web-search.js";

/**
 * Guidance section for the `web_search` tool. Registered wherever the
 * tool is registered so the model always sees the same contract.
 */
function webSearchGuidance(): string {
	return [
		"Use web_search to find current information on the web. Provide a single",
		"query; optionally bound the result count (limit) and express language,",
		"region, and safe-search preferences. Results are citeable sources with a",
		"url, and a title/snippet/source when the search backend supplies them.",
		"Prefer the most recent, authoritative source for time-sensitive facts.",
		`Note: this deployment has no search backend wired in yet — calls to ${WEB_SEARCH_TOOL_NAME}`,
		"fail with a structured 'capability_unavailable' error until one is configured."
	].join(" ");
}

/**
 * The plugin. `inject` declares the services the plugin requires; it only
 * loads while all of them are available.
 */
export const googleSearchPlugin: Plugin.Object = {
	name: "google-search",
	inject: ["tools", "systemPrompt"],
	apply(ctx: Context) {
		ctx.systemPrompt.section({
			name: "tool:web_search",
			order: 110,
			text: webSearchGuidance()
		});
		// The returned disposer is fiber-scoped: Cordis unregisters the tool
		// when this plugin's fiber disposes. No manual teardown needed.
		ctx.tools.register(buildWebSearchTool());
	}
};

export default googleSearchPlugin;
