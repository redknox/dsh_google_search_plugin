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
 * schema for its composition input so it is configurable **without editing
 * runtime source** — the Harness validates and supplies it through the
 * standard plugin-config contract. When a settings service is mounted, the
 * persisted {@link Settings} schema (which has **no** `apiKey` field) is
 * exposed as the `google-search` settings section, with a `validate` hook
 * that rejects any write carrying a raw key before it is persisted. The
 * Google API credential is normally supplied through an environment-backed
 * reference (`apiKeyEnv`, a `role("credential-ref")` field) resolved per
 * operation through the Harness credential facilities or the launching
 * environment — never stored in ordinary settings (ENGINEERING.md §4). A
 * literal key is accepted only as composition input (a `role("secret")`
 * field on {@link Config}), passed straight to the provider and stripped from
 * every read surface.
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

import {
	Config,
	Settings,
	GOOGLE_SEARCH_API_KEY_ENV,
	GOOGLE_SEARCH_ENGINE_ID_ENV,
	rejectApiKeyInSettings,
	settingsFromConfigInput,
	type GoogleSearchConfigInput,
	type GoogleSearchSettings
} from "./provider/config.js";
import { buildGoogleSearchProvider, GOOGLE_SEARCH_PROVIDER_ID } from "./provider/google.js";

export { buildGoogleSearchProvider, GOOGLE_SEARCH_PROVIDER_ID } from "./provider/google.js";
export {
	Config,
	Settings,
	GOOGLE_SEARCH_API_KEY_ENV,
	GOOGLE_SEARCH_ENGINE_ID_ENV,
	rejectApiKeyInSettings,
	settingsFromConfigInput
} from "./provider/config.js";

/** Settings namespace carrying the plugin's configuration section. */
export const GOOGLE_SEARCH_SETTINGS_NAMESPACE = settingsNamespace("google-search");

/**
 * The plugin. `inject` declares the services the plugin requires; it only
 * loads while all of them are available. `Config` is the plugin's
 * **composition** configuration schema (the persisted settings plus a literal
 * `apiKey`), validated by the Harness at load. When a settings service is
 * mounted, the persisted {@link Settings} schema (no `apiKey`) is registered
 * as the `google-search` settings section, with a `validate` hook that rejects
 * any write carrying a raw key — so the credential can never be persisted
 * through the ordinary settings path.
 */
export const googleSearchPlugin: Plugin.Object = {
	name: "google-search",
	inject: ["web"],
	Config,
	apply(ctx: Context, config: GoogleSearchConfigInput) {
		// Split the composition input: the persisted settings (no apiKey) and
		// the literal credential (a role("secret") value, never persisted).
		const settings = settingsFromConfigInput(config);
		const literalApiKey = config.apiKey;

		// The active settings source: the resolved settings scope while a
		// settings service is attached, the composition entry otherwise
		// (installSettingsSection is a no-op when no settings service is
		// mounted, so `current` stays the entry).
		let current = (): GoogleSearchSettings => settings;
		installSettingsSection<GoogleSearchSettings>(ctx, GOOGLE_SEARCH_SETTINGS_NAMESPACE, Settings, settings, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {},
			// Reject any write that carries a raw apiKey before it is
			// persisted (see ./config.ts). This is what guarantees the
			// ordinary settings path cannot store a credential.
			validate: rejectApiKeyInSettings
		});

		// The returned disposer is fiber-scoped: Cordis unregisters the
		// provider when this plugin's fiber disposes. No manual teardown
		// needed. The settings source is passed as a thunk: while a settings
		// service is attached it re-reads the resolved scope, so a settings
		// change takes effect on the next search without re-registering the
		// provider. The literal key is passed separately (never via the
		// settings section).
		ctx.web.registerSearchProvider(buildGoogleSearchProvider({ settings: current, apiKey: literalApiKey, ctx }));
	}
};

export default googleSearchPlugin;
