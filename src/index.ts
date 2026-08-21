/**
 * DSH plugin entry (Issues #2, #4, #6) — provider-only.
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
 * Configuration (Issue #6): the plugin carries a schemastery {@link Config}
 * schema so it is configurable **without editing runtime source** — the
 * Harness validates and supplies it through the standard plugin-config
 * contract, and (when a settings service is mounted) exposes it as the
 * `google-search` settings section. The Google API credential is a
 * `role("secret")` field (redacted before persistence) and is normally
 * supplied through an environment-backed reference (`apiKeyEnv`, a
 * `role("credential-ref")` field) resolved per operation through the
 * Harness credential facilities or the launching environment — never stored
 * in ordinary settings (ENGINEERING.md §4).
 *
 * The provider's `available()` reports that a *resolution path* exists for
 * the credential and engine id (the canonical DSH credential pattern); when
 * no path yields a value, `search()` fails with a structured, actionable
 * `MISSING_CREDENTIAL` error naming the missing setting/environment
 * variables (never their values).
 *
 * Lifecycle: `ctx.web.registerSearchProvider` returns a disposer that is
 * disposed with the calling fiber, so Cordis unregisters the provider
 * automatically when the plugin's fiber unloads — no manual teardown.
 */

import type { Context, Plugin } from "@deepseek-ai/cordis";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

import { Config, type GoogleSearchSettings } from "./provider/config.js";
import { buildGoogleSearchProvider, GOOGLE_SEARCH_PROVIDER_ID } from "./provider/google.js";

export { buildGoogleSearchProvider, GOOGLE_SEARCH_PROVIDER_ID } from "./provider/google.js";
export { Config, GOOGLE_SEARCH_API_KEY_ENV, GOOGLE_SEARCH_ENGINE_ID_ENV } from "./provider/config.js";

/** Settings namespace carrying the plugin's configuration section. */
export const GOOGLE_SEARCH_SETTINGS_NAMESPACE = settingsNamespace("google-search");

/**
 * The plugin. `inject` declares the services the plugin requires; it only
 * loads while all of them are available. `Config` is the plugin's
 * configuration schema (validated by the Harness at load and, when a
 * settings service is mounted, editable through the `google-search`
 * settings section).
 */
export const googleSearchPlugin: Plugin.Object = {
	name: "google-search",
	inject: ["web"],
	Config,
	apply(ctx: Context, config: GoogleSearchSettings) {
		// The active configuration source: the resolved settings scope while a
		// settings service is attached, the composition entry otherwise
		// (installSettingsSection is a no-op when no settings service is
		// mounted, so `current` stays the entry).
		let current = () => config;
		installSettingsSection(ctx, GOOGLE_SEARCH_SETTINGS_NAMESPACE, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {}
		});

		// The returned disposer is fiber-scoped: Cordis unregisters the
		// provider when this plugin's fiber disposes. No manual teardown needed.
		// The settings source is passed as a thunk: while a settings service
		// is attached it re-reads the resolved scope, so a settings change
		// takes effect on the next search without re-registering the provider.
		ctx.web.registerSearchProvider(buildGoogleSearchProvider({ settings: current, ctx }));
	}
};

export default googleSearchPlugin;
