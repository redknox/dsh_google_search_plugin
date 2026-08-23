/**
 * Google search configuration (Issues #4, #6).
 *
 * The plugin is configurable **without editing runtime source** (Issue #6
 * acceptance 1): its settings are a schemastery schema carried on the plugin
 * object, so the Harness validates and supplies them through the standard
 * plugin-config contract (Cordis `Config`) and, when a settings service is
 * mounted, through a `google-search` settings section
 * (`installSettingsSection`, `@deepseek-ai/dsh-settings`).
 *
 * **Credential handling** (Issue #6 acceptance 2). The Google API credential
 * is kept out of the persisted settings by *design*, not by read-time
 * redaction: the schema registered with the settings service
 * ({@link Settings}) contains **no** `apiKey` field, and a `validate` hook
 * ({@link rejectApiKeyInSettings}) rejects any write that tries to submit one
 * — so the ordinary `ctx.settings.update()` path can never place a raw key in
 * the settings file. The normal path is an **environment-backed reference**:
 * `apiKeyEnv` is a `role("credential-ref")` field naming the environment
 * variable (or Harness credential reference) that holds the key. The
 * credential value itself is resolved **per operation** through the Harness
 * credential facilities when available, then the launching environment —
 * never cached, never persisted, never logged (ENGINEERING.md §4).
 *
 * A literal `apiKey` is still accepted as **plugin composition input** (the
 * {@link Config} schema, used only to validate the value handed to
 * `ctx.plugin(...)`); it is a `role("secret")` field that is passed straight
 * to the provider and is *never* part of the settings section. This is the
 * separation the review of Issue #6 required: a composition-only secret,
 * distinct from the schema the settings service persists.
 *
 * The search engine id (`cx`) is **not** a secret: it identifies the
 * Programmable Search Engine and is a plain, persistable setting.
 *
 * A blank (empty or whitespace-only) value is treated as **absent** — the
 * same absent/blank discipline the normalization layer applies to optional
 * fields (ENGINEERING.md §2: no silent unknown → concrete value).
 */

import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import type { Context } from "@deepseek-ai/cordis";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

/** The default environment variable holding the Google API credential (secret). */
export const GOOGLE_SEARCH_API_KEY_ENV = "GOOGLE_SEARCH_API_KEY";

/** The default environment variable holding the Programmable Search Engine id (`cx`). */
export const GOOGLE_SEARCH_ENGINE_ID_ENV = "GOOGLE_SEARCH_ENGINE_ID";

/**
 * The **persisted** settings schema — the single source of truth for every
 * exposed *non-secret* setting, its default, and its user-facing description
 * (Issue #6 acceptance 4). This is the schema registered with the settings
 * service, so it must contain **no** `apiKey` field: the credential is kept
 * out of the settings file by construction (see {@link Settings} and
 * {@link rejectApiKeyInSettings}).
 *
 * The Harness renders these descriptions in its generic, schema-driven
 * settings surface; no provider-specific settings page exists (Issue #6
 * non-goal).
 *
 * Defaults preserve the simplest usable search experience (acceptance 5):
 * with no configuration at all the provider searches with Google's own
 * defaults (10 results, no language/region restriction, SafeSearch off) and
 * only the credential + engine id must be supplied.
 */
const settingsFields = {
	/**
	 * The name of the environment variable (or Harness credential reference)
	 * holding the API credential. `role("credential-ref")`: this is a
	 * *reference*, not a value — the value itself is resolved per operation
	 * and never persisted.
	 */
	apiKeyEnv: z
		.string()
		.role("credential-ref")
		.default(GOOGLE_SEARCH_API_KEY_ENV)
		.description(
			"Environment variable holding the Google API credential. " +
				"Set this variable (or store the credential under this name in the " +
				"Harness credential facilities) to configure the plugin."
		),
	/**
	 * The Programmable Search Engine id (`cx`), required by the Custom
	 * Search JSON API. Non-secret: it identifies the engine, not the
	 * account, so it may live in ordinary settings.
	 */
	engineId: z
		.string()
		.default("")
		.description(
			"Google Programmable Search Engine id (the `cx` parameter), e.g. from the " +
				"Programmable Search Engine control panel. Required for searches; may be " +
				"set here or via the GOOGLE_SEARCH_ENGINE_ID environment variable."
		),
	/**
	 * Default maximum number of results per search. The Custom Search JSON
	 * API returns at most 10 per request, so the bound is 1..10; larger
	 * caller bounds are clamped to 10.
	 */
	maxResults: z
		.number()
		.step(1)
		.min(1)
		.max(10)
		.default(10)
		.description(
			"Default maximum number of results per search (1–10; the Google API returns " +
				"at most 10 per request)."
		),
	/**
	 * SafeSearch filtering for the engine. Maps to the API's `safe`
	 * parameter: `"active"` enables filtering, `"off"` disables it (Google's
	 * default).
	 */
	safeSearch: z
		.union([z.const("off"), z.const("active")])
		.default("off")
		.description(
			"SafeSearch filtering: \"off\" (Google's default) or \"active\" to filter " +
				"explicit results."
		),
	/**
	 * Result language restriction. Maps to the API's `lr` parameter
	 * (e.g. `lang_ja`); empty means no restriction. Free-form because Google
	 * publishes the accepted values as an open, changing set — the stable
	 * user semantics are "the language Google accepts", not a closed enum.
	 */
	language: z
		.string()
		.default("")
		.description(
			"Restrict results to a language, using Google's `lr` value (e.g. \"lang_ja\"). " +
				"Empty means no language restriction."
		),
	/**
	 * Result region boost. Maps to the API's `gl` parameter (a two-letter
	 * country code, e.g. `US`); empty means no boost. Free-form for the same
	 * reason as {@link language}.
	 */
	region: z
		.string()
		.default("")
		.description(
			"Boost results from a region, using a two-letter country code (Google's `gl` " +
				"parameter, e.g. \"US\"). Empty means no region boost."
		),
	/**
	 * Per-request timeout in milliseconds. The Google API documents no
	 * timeout of its own; this bounds the plugin's own HTTP call so a hung
	 * request degrades to a stable `TIMEOUT` error instead of hanging the
	 * caller. (The tool-level cooperative timeout still applies on top.)
	 */
	requestTimeoutMs: z
		.number()
		.step(1)
		.min(1000)
		.default(30_000)
		.description(
			"Timeout for a single Google search request, in milliseconds (minimum 1000). " +
				"A request exceeding it fails with a TIMEOUT error."
		)
};

export const Settings = z.object(settingsFields);

/**
 * The **plugin composition** configuration schema: the persisted
 * {@link Settings} plus a literal `apiKey` accepted *only* as the value
 * handed to `ctx.plugin(...)`. This schema is used to validate the
 * composition input (Cordis `Config`); it is **not** the schema registered
 * with the settings service, so the literal key never enters the settings
 * section and can never be persisted.
 *
 * `apiKey` is a `role("secret")` field: it is stripped from every *read*
 * surface by the `redactSecrets` contract, and — because it is absent from
 * the persisted {@link Settings} schema — it is absent from the settings file
 * by construction. Prefer the environment-backed reference (`apiKeyEnv`); a
 * literal key exists only for hosts without a credential facility.
 */
export const Config = z.object({
	/**
	 * The literal Google API credential, accepted **only** as plugin
	 * composition input (the value handed to `ctx.plugin(...)`).
	 * `role("secret")`: stripped from every *read* surface by the
	 * `redactSecrets` contract. It is never part of the persisted
	 * {@link Settings} schema and never registered with the settings
	 * service, so it can never be written to the settings file.
	 */
	apiKey: z
		.string()
		.role("secret")
		.description(
			"Google API credential used to authenticate Custom Search requests. " +
				"Accepted only as plugin composition input (never stored in settings). " +
				"Prefer setting the GOOGLE_SEARCH_API_KEY environment variable (see apiKeyEnv)."
		),
	...settingsFields
});

/** The resolved, validated settings (all non-secret fields present, defaults applied). */
export type GoogleSearchSettings = ReturnType<typeof Settings>;

/** The resolved, validated plugin composition configuration (settings + optional literal key). */
export type GoogleSearchConfigInput = ReturnType<typeof Config>;

/**
 * Derive the persisted {@link Settings} from a plugin composition input,
 * dropping the literal `apiKey`.
 *
 * This is the value registered as the settings section's composition `base`
 * and used as the provider's settings source when no settings service is
 * mounted. It is fully resolved (defaults applied) so the provider always
 * sees a complete settings object, and it is guaranteed to carry **no**
 * `apiKey` — the literal key is handed to the provider separately.
 *
 * @param config - the validated plugin composition configuration.
 */
export function settingsFromConfigInput(config: GoogleSearchConfigInput): GoogleSearchSettings {
	const { apiKey: _apiKey, ...rest } = config;
	return Settings(rest);
}

/**
 * The resolved, usable Google search configuration for one operation.
 *
 * The credential values are runtime-only (ENGINEERING.md §4): they are
 * resolved per operation, never cached on the provider, never serialized
 * anywhere except the outgoing request URL, and never included in any error
 * message.
 */
export interface GoogleSearchConfig {
	/** The Google API credential. Never logged, never committed. */
	readonly apiKey: string;
	/** The Programmable Search Engine id required by the Custom Search JSON API. */
	readonly cx: string;
}

/**
 * The outcome of resolving the runtime configuration: either a usable
 * {@link GoogleSearchConfig}, or the *names* of the settings/environment
 * variables that are missing (or blank). The missing *names* are safe to
 * surface in error messages; the values are never surfaced.
 */
export interface GoogleSearchConfigResolution {
	readonly config?: GoogleSearchConfig;
	readonly missing: readonly string[];
}

/**
 * Read an env value, trimming surrounding whitespace; return `undefined`
 * when it is absent or blank (treated as absent, never defaulted).
 */
function asNonBlank(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the Google search configuration from an env source.
 *
 * @param env - the env source to read (defaults to `process.env`); injectable
 *   so tests never depend on the real process environment.
 * @returns the resolved configuration when both values are present and
 *   non-blank, otherwise the list of missing variable names (never values).
 */
export function resolveGoogleSearchConfig(
	env: Record<string, string | undefined> = process.env
): GoogleSearchConfigResolution {
	const apiKey = asNonBlank(env[GOOGLE_SEARCH_API_KEY_ENV]);
	const cx = asNonBlank(env[GOOGLE_SEARCH_ENGINE_ID_ENV]);

	const missing: string[] = [];
	if (apiKey === undefined) {
		missing.push(GOOGLE_SEARCH_API_KEY_ENV);
	}
	if (cx === undefined) {
		missing.push(GOOGLE_SEARCH_ENGINE_ID_ENV);
	}

	if (missing.length > 0) {
		return { missing };
	}
	return { config: { apiKey: apiKey as string, cx: cx as string }, missing: [] };
}

/**
 * Resolve the API credential for one operation (Issue #6: credentials stay
 * in the Harness credential facilities or environment-backed references,
 * never in ordinary settings).
 *
 * Resolution order — the first source with a non-blank value wins:
 *
 *   1. a literal `apiKey` supplied as plugin composition input (a
 *      `role("secret")` field on the composition {@link Config}; it is *not*
 *      part of the persisted settings, so it can never be written to the
 *      settings file);
 *   2. the Harness **credentials** service, resolving the `apiKeyEnv`
 *      reference (the canonical DSH credential path);
 *   3. the **launching environment** (user/project env layers) under the
 *      `apiKeyEnv` name;
 *   4. the process environment under the `apiKeyEnv` name (the fallback for
 *      hosts without a launching-environment service).
 *
 * The resolved value is returned to the caller for the single operation and
 * is never cached here or on the provider.
 *
 * @param ctx - the plugin context (supplies the credentials service and the
 *   launching environment). May be `undefined` for the bare, context-free
 *   provider path (tests, `buildGoogleSearchProvider({ env })`), in which
 *   case only the literal and process-environment sources are consulted.
 * @param settings - the currently authoritative settings section (the
 *   non-secret {@link Settings}; supplies `apiKeyEnv`).
 * @param literalApiKey - the literal credential from the plugin composition
 *   input, if any (a `role("secret")` value that is never persisted).
 * @param env - optional explicit env source (defaults to `process.env`);
 *   injectable so tests never depend on the real process environment.
 * @returns the resolved credential, or `undefined` when no source has one.
 */
export async function resolveGoogleSearchCredential(
	ctx: Context | undefined,
	settings: GoogleSearchSettings,
	literalApiKey: string | undefined,
	env: Record<string, string | undefined> = process.env
): Promise<string | undefined> {
	// 1. Literal (secret) value from the plugin composition input.
	const literal = asNonBlank(literalApiKey);
	if (literal !== undefined) {
		return literal;
	}

	const name = asNonBlank(settings.apiKeyEnv) ?? GOOGLE_SEARCH_API_KEY_ENV;

	// 2. Harness credential facilities (when the service is mounted).
	if (ctx !== undefined) {
		const credentials = ctx.get("credentials");
		if (credentials !== undefined) {
			const resolved = await credentials.resolve(credentialRef(name));
			const value = asNonBlank(resolved?.value);
			if (value !== undefined) {
				return value;
			}
		}
		// 3. Launching environment (user/project env layers).
		const ambient = launchEnvironmentOf(ctx).get(name);
		const ambientValue = asNonBlank(ambient?.value);
		if (ambientValue !== undefined) {
			return ambientValue;
		}
	}

	// 4. Process environment (bare provider path / hosts without the
	//    launching-environment service).
	return asNonBlank(env[name]);
}

/**
 * Resolve the search engine id (`cx`) for one operation.
 *
 * The engine id is **not** a secret, so it may live in ordinary settings
 * (the `engineId` field). The environment variable remains the documented
 * runtime path: a non-blank `engineId` setting wins, then the environment.
 *
 * @param config - the currently authoritative configuration section.
 * @param env - the env source to read (defaults to `process.env`).
 * @returns the engine id, or `undefined` when no source has one.
 */
export function resolveGoogleSearchEngineId(
	config: GoogleSearchSettings,
	env: Record<string, string | undefined> = process.env
): string | undefined {
	return asNonBlank(config.engineId) ?? asNonBlank(env[GOOGLE_SEARCH_ENGINE_ID_ENV]);
}

/**
 * Whether the provider has at least one *resolution path* for every required
 * value — the cheap, synchronous check the seam's `available()` contract
 * requires (no network, no async resolution).
 *
 * A resolution path exists for the credential when a literal key is supplied
 * as composition input, the credentials service is mounted, the launching
 * environment carries the variable, or the process environment carries it;
 * for the engine id when a non-blank setting or environment value exists.
 * Actual resolution — and the actionable `MISSING_CREDENTIAL` failure when no
 * path yields a value — happens per operation in `search()` (the canonical
 * DSH credential pattern: `available()` reports that a path exists, never
 * that a value is present).
 *
 * @param ctx - the plugin context, or `undefined` for the bare provider path.
 * @param settings - the currently authoritative settings section.
 * @param literalApiKey - the literal credential from the plugin composition
 *   input, if any.
 * @param env - the env source (defaults to `process.env`).
 */
export function googleSearchConfigPathExists(
	ctx: Context | undefined,
	settings: GoogleSearchSettings,
	literalApiKey: string | undefined,
	env: Record<string, string | undefined> = process.env
): boolean {
	const name = asNonBlank(settings.apiKeyEnv) ?? GOOGLE_SEARCH_API_KEY_ENV;
	const credentialPath =
		asNonBlank(literalApiKey) !== undefined ||
		(ctx !== undefined && (ctx.get("credentials") !== undefined || launchEnvironmentOf(ctx).get(name) !== undefined)) ||
		asNonBlank(env[name]) !== undefined;
	const engineIdPath = asNonBlank(settings.engineId) !== undefined || asNonBlank(env[GOOGLE_SEARCH_ENGINE_ID_ENV]) !== undefined;
	return credentialPath && engineIdPath;
}

/**
 * The settings-service `validate` hook for the `google-search` section
 * (Issue #6 acceptance 2, review-required).
 *
 * The persisted {@link Settings} schema has no `apiKey` field, but the
 * settings layer persists the raw user section *verbatim* and its read-time
 * redaction (`redactSecrets`) does not run on the write path. This hook
 * closes that gap: it runs inside the settings `resolve()` — i.e. **before**
 * the section is persisted — and throws if the resolved value carries an
 * `apiKey`. Because the hook throws before `persist()` is reached, a raw key
 * submitted through the ordinary `ctx.settings.update()` / `replace()` /
 * `mutate()` path is rejected and **cannot** be written to the settings file.
 *
 * This is what makes acceptance 2 a guaranteed property rather than a
 * convention: the normal settings write path cannot place a raw API key on
 * disk. The literal key is deliberately accepted only as plugin composition
 * input (the {@link Config} schema), which is validated separately and never
 * registered with the settings service.
 *
 * @param value - the resolved settings value (schema defaults + base + user).
 * @throws {Error} when an `apiKey` is present (any value, including blank).
 */
export function rejectApiKeyInSettings(value: unknown): void {
	if (typeof value === "object" && value !== null && "apiKey" in value) {
		throw new Error(
			'google-search settings: "apiKey" is a secret and cannot be stored in settings. ' +
				"Set the GOOGLE_SEARCH_API_KEY environment variable (or store the credential " +
				"under the apiKeyEnv name in the Harness credential facilities) instead."
		);
	}
}
