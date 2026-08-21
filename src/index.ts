/**
 * DSH plugin entry (Issue #2) — provider-only.
 *
 * Registers the Google search provider on the web capability seam
 * (`ctx.web`, `@deepseek-ai/dsh-web`) through public DSH extension
 * contracts only — the Cordis `Context` and the `web` service — with no
 * Agent Loop internals and no private imports (Issue #2 acceptance).
 *
 * This plugin does **not** own a model-facing tool. The `web_search` tool,
 * its schema, and its prompt guidance are owned by
 * `@deepseek-ai/dsh-tool-web`; this plugin only supplies a search backend
 * to that existing tool (ARCHITECTURE.md).
 *
 * The provider's runtime configuration (API credential + search engine id)
 * is resolved from environment variables at load time (Issue #4,
 * ENGINEERING.md §4); when it is incomplete the provider registers but
 * reports `available()` false, so the seam keeps reporting the capability
 * as unavailable until the runtime configuration is supplied.
 *
 * Lifecycle: `ctx.web.registerSearchProvider` returns a disposer that is
 * disposed with the calling fiber, so Cordis unregisters the provider
 * automatically when the plugin's fiber unloads — no manual teardown.
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";
import { buildGoogleSearchProvider, GOOGLE_SEARCH_PROVIDER_ID } from "./provider/google.js";

export { buildGoogleSearchProvider, GOOGLE_SEARCH_PROVIDER_ID } from "./provider/google.js";

/**
 * The plugin. `inject` declares the services the plugin requires; it only
 * loads while all of them are available.
 */
export const googleSearchPlugin: Plugin.Object = {
	name: "google-search",
	inject: ["web"],
	apply(ctx: Context) {
		// The returned disposer is fiber-scoped: Cordis unregisters the
		// provider when this plugin's fiber disposes. No manual teardown needed.
		ctx.web.registerSearchProvider(buildGoogleSearchProvider());
	}
};

export default googleSearchPlugin;
