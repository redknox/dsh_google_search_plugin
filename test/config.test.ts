/**
 * Issue #6 acceptance tests (Issue #7 migration) — secure configuration and
 * credential handling.
 *
 * Everything here is **offline**: no network, no live credential. The
 * "credentials" are fake fixture values and mock services (a mock
 * `credentials` service and a mock `launchEnvironment` service standing in
 * for the Harness credential facilities), and the settings service is the
 * real `FileSettingsProvider` pointed at a throwaway file.
 *
 * Coverage against the acceptance criteria:
 *   1. configurable without editing runtime source
 *        → the plugin carries a `Config` schema (validated by the Harness at
 *          load) and a `google-search` settings section that the provider
 *          re-reads per search (a settings change applies without a reload);
 *   2. raw API keys not stored in normal settings
 *        → the persisted settings schema has NO `apiKey` field, and a
 *          `validate` hook rejects any write carrying one — so the ordinary
 *          `ctx.settings.update()` path cannot place a raw key on disk
 *          (proved by the exact regression test the review required). The
 *          literal key is accepted only as plugin composition input (a
 *          `role("secret")` field on the composition `Config`), is stripped
 *          from every read surface by `redactSecrets`, and is passed to the
 *          provider separately — never through the settings section.
 *   3. missing credentials fail with an actionable, stable error
 *        → `MISSING_CREDENTIAL` naming the setting/environment variable and
 *          the alternatives, never a value;
 *   4. every user-facing config field explains its meaning
 *        → the schema carries a description for every field;
 *   5. defaults preserve the simplest usable search experience
 *        → `Config(undefined)` yields the documented defaults;
 *   6. config tests cover credential isolation and validation
 *        → this file: isolation (redaction + resolution order) and
 *          validation (schema rejects out-of-range/invalid values).
 *
 * Issue #7 migration: the settings surface is now the Gemini grounding
 * surface — `apiKeyEnv` (default `GEMINI_API_KEY`), `model` (default
 * `gemini-3.6-flash`), and `requestTimeoutMs`. The Custom Search settings
 * (`engineId`, `maxResults`, `language`, `region`, `safeSearch`) are gone:
 * the grounding API needs only an API key and has no per-request search
 * controls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { after } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";
import { WebError, WebRuntime } from "@deepseek-ai/dsh-web";
import { FileSettingsProvider } from "@deepseek-ai/dsh-settings-file";
import { redactSecrets } from "@deepseek-ai/dsh-settings";

import { googleSearchPlugin, GOOGLE_SEARCH_SETTINGS_NAMESPACE } from "../src/index.js";
import {
	Config,
	Settings,
	GEMINI_API_KEY_ENV,
	googleSearchConfigPathExists,
	rejectApiKeyInSettings,
	resolveGoogleSearchConfig,
	resolveGoogleSearchCredential,
	settingsFromConfigInput,
	type GoogleSearchSettings
} from "../src/provider/config.js";
import { GEMINI_SEARCH_DEFAULT_MODEL } from "../src/provider/transport.js";
import { buildGoogleSearchProvider } from "../src/provider/google.js";
import type { GeminiHttpTransport, GeminiHttpResponse, GeminiSearchHttpRequest } from "../src/provider/transport.js";

// ---------------------------------------------------------------------------
// Fixtures — fake values only; never a real credential.
// ---------------------------------------------------------------------------

/** Temp settings dirs created by this file; removed after the file finishes. */
const tempDirs: string[] = [];
after(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

/** Create a throwaway settings dir (tracked for cleanup). */
async function makeTempDir(): Promise<{ dir: string; file: string }> {
	const dir = await mkdtemp(path.join(tmpdir(), "dsh-google-search-settings-"));
	tempDirs.push(dir);
	return { dir, file: path.join(dir, "settings.yaml") };
}

const FAKE_API_KEY = "fake-api-key-000";
const LITERAL_KEY = "literal-secret-key-000";

const CONFIGURED_ENV: Record<string, string | undefined> = {
	[GEMINI_API_KEY_ENV]: FAKE_API_KEY
};

const SUCCESS_BODY = JSON.stringify({
	candidates: [
		{
			content: { parts: [{ text: "The answer." }] },
			groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com/x", title: "example.com" } }] }
		}
	]
});

/** The persisted settings schema's defaults as a concrete section. */
function defaultSettings(overrides: Partial<GoogleSearchSettings> = {}): GoogleSearchSettings {
	return Settings({ ...overrides });
}

/** A mock transport that records calls and replies from a handler. */
function makeTransport(
	handler: (
		request: GeminiSearchHttpRequest,
		signal?: AbortSignal
	) => GeminiHttpResponse | Promise<GeminiHttpResponse>
) {
	const calls: { request: GeminiSearchHttpRequest; signal?: AbortSignal | undefined }[] = [];
	const transport: GeminiHttpTransport = async (request, signal) => {
		calls.push({ request, signal });
		return handler(request, signal);
	};
	return { transport, calls };
}

/** A mock transport that hangs until its signal aborts (rejects with the reason). */
function makeHangingTransport() {
	const transport: GeminiHttpTransport = (_request, signal) =>
		new Promise<GeminiHttpResponse>((_resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	return transport;
}

/** Parse the JSON body of a captured request. */
function parsedBody(request: GeminiSearchHttpRequest): Record<string, unknown> {
	return JSON.parse(request.body) as Record<string, unknown>;
}

/**
 * Synchronously validate a config object against the schema. schemastery's
 * `~standard.validate` is typed as `Result | Promise<Result>`; this schema is
 * fully synchronous, so the result is a plain `Result` (cast, not awaited).
 */
function validateConfig(
	input: unknown
): { issues?: readonly { message: string }[]; value?: unknown } {
	return Config["~standard"].validate(input) as {
		issues?: readonly { message: string }[];
		value?: unknown;
	};
}

/** Synchronously validate against the persisted settings schema. */
function validateSettings(
	input: unknown
): { issues?: readonly { message: string }[]; value?: unknown } {
	return Settings["~standard"].validate(input) as {
		issues?: readonly { message: string }[];
		value?: unknown;
	};
}

/**
 * `redactSecrets` is typed against `z<never>` (it accepts any schema); under
 * `exactOptionalPropertyTypes` the concrete schema is not assignable, so cast
 * through `unknown` to the declared parameter type.
 */
const configSchemaForRedaction = Config as unknown as Parameters<typeof redactSecrets>[0];

/** Assert a rejected search threw a `WebError` with the given code. */
async function expectWebError(promise: Promise<unknown>, code: string): Promise<WebError> {
	try {
		await promise;
	} catch (err) {
		assert.ok(err instanceof WebError, `expected WebError, got: ${String(err)}`);
		assert.equal((err as WebError).code, code);
		assert.ok(
			!((err as WebError).message ?? "").includes(FAKE_API_KEY) &&
				!((err as WebError).message ?? "").includes(LITERAL_KEY),
			`error message must not contain a credential: ${(err as WebError).message}`
		);
		return err as WebError;
	}
	assert.fail(`expected a WebError with code ${code}, but the promise resolved`);
}

/** A mock `credentials` service: resolves a reference to a stored value. */
class MockCredentials extends Service {
	private values: Record<string, string>;
	constructor(ctx: Context, values: Record<string, string>) {
		super(ctx, "credentials");
		this.values = values;
	}
	async resolve(ref: unknown): Promise<{ value: string; source: string } | undefined> {
		const name = typeof ref === "string" ? ref : String((ref as { value?: unknown })?.value ?? ref);
		const value = this.values[name];
		return value !== undefined ? { value, source: "mock-credentials" } : undefined;
	}
}

/** A mock `launchEnvironment` service: reads names from a fixed snapshot. */
class MockLaunchEnvironment extends Service {
	private values: Record<string, string>;
	constructor(ctx: Context, values: Record<string, string>) {
		super(ctx, "launchEnvironment");
		this.values = values;
	}
	get(name: string): { value: string; source: string } | undefined {
		const value = this.values[name];
		return value !== undefined ? { value, source: "mock-launch-environment" } : undefined;
	}
}

// ---------------------------------------------------------------------------
// Schema: defaults and validation (acceptance 4, 5, 6)
// ---------------------------------------------------------------------------

test("Settings: defaults preserve the simplest usable search experience", () => {
	const value = Settings(undefined);
	assert.deepEqual(value, {
		apiKeyEnv: GEMINI_API_KEY_ENV,
		model: GEMINI_SEARCH_DEFAULT_MODEL,
		requestTimeoutMs: 30_000
	});
	// The persisted settings schema has NO apiKey field (acceptance 2): the
	// credential is never a settings field, so it can never be persisted.
	assert.ok(!("apiKey" in value), "the persisted settings carry no apiKey field");
});

test("Settings: a partial input merges over the defaults", () => {
	const value = Settings({ model: "gemini-3.5-flash" });
	assert.equal(value.model, "gemini-3.5-flash");
	assert.equal(value.apiKeyEnv, GEMINI_API_KEY_ENV, "untouched fields keep their defaults");
	assert.equal(value.requestTimeoutMs, 30_000);
});

test("Settings: rejects a path-injecting model name", () => {
	for (const model of ["a/b", "a:b", "a b", ""]) {
		const result = validateSettings({ model });
		assert.ok(result.issues, `model ${JSON.stringify(model)} must be rejected`);
	}
	assert.throws(() => Settings({ model: "a/b" }));
});

test("Settings: rejects a requestTimeoutMs below the minimum", () => {
	assert.ok(validateSettings({ requestTimeoutMs: 10 }).issues, "10ms must be rejected");
	assert.ok(Settings(undefined).requestTimeoutMs >= 1000, "the default is at least the minimum");
});

test("Settings: the removed Custom Search settings are not part of the schema", () => {
	// Issue #7 migration: engineId/maxResults/language/region/safeSearch had
	// no grounding-API equivalent and must not linger as dead configuration.
	const value = Settings(undefined);
	for (const removed of ["engineId", "maxResults", "language", "region", "safeSearch"]) {
		assert.ok(!(removed in value), `the removed setting "${removed}" must not be in the settings`);
	}
});

test("Config: the composition schema accepts a literal apiKey (composition-only)", () => {
	const value = Config({ apiKey: LITERAL_KEY, model: "gemini-3.5-flash" });
	assert.equal(value.apiKey, LITERAL_KEY, "the literal key is accepted as composition input");
	assert.equal(value.model, "gemini-3.5-flash");
	// …and the persisted settings derived from it drop the key.
	const settings = settingsFromConfigInput(value);
	assert.ok(!("apiKey" in settings), "the derived settings carry no apiKey");
	assert.equal(settings.model, "gemini-3.5-flash", "the non-secret fields survive the split");
});

/** Extract a field's description from a schemastery serialized object schema. */
function fieldDescription(schema: { toJSON: () => unknown }, field: string): string | undefined {
	const serialized = schema.toJSON() as unknown as {
		uid: number;
		refs: Record<string, { dict?: Record<string, number>; meta?: { description?: string } }>;
	};
	const objectRef = serialized.refs[String(serialized.uid)]!;
	const fieldRefId = objectRef.dict?.[field];
	if (fieldRefId === undefined) return undefined;
	return serialized.refs[String(fieldRefId)]!.meta?.description;
}

test("Settings: every persisted field carries a description (acceptance 4)", () => {
	// The persisted settings schema (what configuration surfaces render) must
	// explain every field the user can set.
	const fields = ["apiKeyEnv", "model", "requestTimeoutMs"];
	for (const field of fields) {
		const description = fieldDescription(Settings, field);
		assert.ok(
			typeof description === "string" && description.trim().length > 0,
			`persisted field "${field}" must carry a user-facing description`
		);
	}
	// The persisted schema must NOT expose an apiKey field at all.
	assert.equal(fieldDescription(Settings, "apiKey"), undefined, "no apiKey field in the persisted schema");
});

test("Config: the composition-only apiKey carries a description", () => {
	const description = fieldDescription(Config, "apiKey");
	assert.ok(
		typeof description === "string" && description.trim().length > 0,
		"the composition apiKey field must carry a user-facing description"
	);
});

// ---------------------------------------------------------------------------
// Credential isolation (acceptance 2, 6)
// ---------------------------------------------------------------------------

test("redactSecrets: a literal apiKey never crosses the settings wire", () => {
	const redacted = redactSecrets(configSchemaForRedaction, Config({ apiKey: LITERAL_KEY, model: "gemini-3.5-flash" }));
	const value = redacted.value as Record<string, unknown>;
	assert.equal(value.apiKey, undefined, "the secret field is stripped from the value");
	assert.equal(value.model, "gemini-3.5-flash", "non-secret fields survive");
	assert.deepEqual(redacted.secrets, [{ path: ["apiKey"], set: true }], "the secret position is enumerated");
	assert.ok(!JSON.stringify(redacted.value).includes(LITERAL_KEY), "no trace of the key in the redacted value");
});

test("redactSecrets: an unset apiKey still enumerates the slot (write-only input)", () => {
	const redacted = redactSecrets(configSchemaForRedaction, Config(undefined));
	assert.equal((redacted.value as Record<string, unknown>).apiKey, undefined);
	assert.deepEqual(redacted.secrets, [{ path: ["apiKey"], set: false }]);
});

/** Read a settings file, returning "" when it does not exist yet. */
async function readFileOrEmpty(file: string): Promise<string> {
	try {
		return await readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw err;
	}
}

test("rejectApiKeyInSettings: throws when an apiKey is present, passes otherwise", () => {
	assert.throws(() => rejectApiKeyInSettings({ apiKey: LITERAL_KEY, model: "gemini-3.5-flash" }), /apiKey/);
	assert.throws(() => rejectApiKeyInSettings({ apiKey: "" }), /apiKey/, "even a blank apiKey is rejected");
	assert.doesNotThrow(() => rejectApiKeyInSettings({ model: "gemini-3.5-flash" }));
	assert.doesNotThrow(() => rejectApiKeyInSettings(Settings(undefined)));
});

test("REGRESSION: a raw apiKey submitted via the ordinary settings update path is rejected and never reaches disk", async () => {
	const { dir, file } = await makeTempDir();
	const ctx = new Context();
	new FileSettingsProvider(ctx, { path: file, dshHome: dir, watch: false });

	// Exactly what the plugin entry registers: the persisted Settings schema
	// (no apiKey field) plus the validate hook that rejects any apiKey.
	ctx.settings.register(GOOGLE_SEARCH_SETTINGS_NAMESPACE, Settings as never, {
		base: Settings(undefined),
		validate: rejectApiKeyInSettings
	});

	// The exact path the review of Issue #6 flagged: submit a raw key through
	// the ordinary settings update. It must be rejected before persistence.
	await assert.rejects(
		() => ctx.settings.update(GOOGLE_SEARCH_SETTINGS_NAMESPACE, { apiKey: LITERAL_KEY } as object),
		/cannot be stored in settings/,
		"the ordinary settings update path must reject a raw apiKey"
	);
	// The other two ordinary write paths (wholesale replace, path-addressed
	// mutate) persist through the same validate-before-persist gate and must
	// reject a raw key the same way.
	await assert.rejects(
		() => ctx.settings.replace(GOOGLE_SEARCH_SETTINGS_NAMESPACE, { apiKey: LITERAL_KEY } as object),
		/cannot be stored in settings/,
		"the replace path must reject a raw apiKey"
	);
	await assert.rejects(
		() => ctx.settings.mutate(GOOGLE_SEARCH_SETTINGS_NAMESPACE, [{ op: "set", path: ["apiKey"], value: LITERAL_KEY }]),
		/cannot be stored in settings/,
		"the mutate path must reject a raw apiKey"
	);

	// The key must not have reached the settings file.
	const onDisk = await readFileOrEmpty(file);
	assert.ok(!onDisk.includes(LITERAL_KEY), "a raw apiKey must not be written to the settings file");
});

test("REGRESSION (end-to-end): the loaded plugin's settings section rejects a raw apiKey", async () => {
	const { dir, file } = await makeTempDir();
	const ctx = new Context();
	new WebRuntime(ctx);
	new FileSettingsProvider(ctx, { path: file, dshHome: dir, watch: false });
	const fiber = ctx.plugin(googleSearchPlugin, {});
	await fiber;

	// The plugin's real registration (Settings schema + validate hook) must
	// reject a raw key submitted through the ordinary settings path.
	await assert.rejects(
		() => ctx.settings.update(GOOGLE_SEARCH_SETTINGS_NAMESPACE, { apiKey: LITERAL_KEY } as object),
		/cannot be stored in settings/
	);
	const onDisk = await readFileOrEmpty(file);
	assert.ok(!onDisk.includes(LITERAL_KEY), "the raw apiKey must not be on disk after a rejected update");
});

test("the composition base (a literal key) is kept out of the persisted settings", async () => {
	const { dir, file } = await makeTempDir();
	const ctx = new Context();
	new FileSettingsProvider(ctx, { path: file, dshHome: dir, watch: false });

	// The plugin entry registers the section with the *derived* settings as
	// the base — the literal key is split off and never part of the base.
	const base = settingsFromConfigInput(Config({ apiKey: LITERAL_KEY, model: "gemini-3.5-flash" }));
	assert.ok(!("apiKey" in base), "the base carries no apiKey");
	const scope = ctx.settings.register<GoogleSearchSettings>(GOOGLE_SEARCH_SETTINGS_NAMESPACE, Settings as never, {
		base,
		validate: rejectApiKeyInSettings
	});

	// The resolved value carries the model but no key.
	assert.equal(scope.get().model, "gemini-3.5-flash");
	assert.ok(!("apiKey" in scope.get()), "the resolved settings carry no apiKey");

	// A settings change writes the USER section (non-secret fields only).
	await ctx.settings.update(GOOGLE_SEARCH_SETTINGS_NAMESPACE, { model: "gemini-3.1-flash" } as object);

	const onDisk = await readFileOrEmpty(file);
	assert.ok(!onDisk.includes(LITERAL_KEY), "the literal key must not be written to the settings file");
	assert.ok(onDisk.includes("model"), "the non-secret user field is persisted");
});

test("the persisted user section holds the apiKeyEnv NAME, never a key value", async () => {
	const { dir, file } = await makeTempDir();
	const ctx = new Context();
	new FileSettingsProvider(ctx, { path: file, dshHome: dir, watch: false });
	ctx.settings.register(GOOGLE_SEARCH_SETTINGS_NAMESPACE, Settings as never, {
		base: Settings(undefined),
		validate: rejectApiKeyInSettings
	});

	// An operator points the plugin at a different credential variable.
	await ctx.settings.update(GOOGLE_SEARCH_SETTINGS_NAMESPACE, { apiKeyEnv: "OTHER_GEMINI_KEY" } as object);

	const onDisk = await readFileOrEmpty(file);
	assert.ok(onDisk.includes("OTHER_GEMINI_KEY"), "the reference NAME is persisted");
	assert.ok(!onDisk.includes(FAKE_API_KEY) && !onDisk.includes(LITERAL_KEY), "no credential value is persisted");
});

// ---------------------------------------------------------------------------
// Credential resolution order (acceptance 2, 3)
// ---------------------------------------------------------------------------

test("resolveGoogleSearchCredential: a literal composition key wins over every other source", async () => {
	const ctx = new Context();
	new MockCredentials(ctx, { [GEMINI_API_KEY_ENV]: FAKE_API_KEY });
	const value = await resolveGoogleSearchCredential(ctx, Settings(undefined), LITERAL_KEY, {});
	assert.equal(value, LITERAL_KEY);
});

test("resolveGoogleSearchCredential: the credentials service is consulted before the environment", async () => {
	const ctx = new Context();
	new MockCredentials(ctx, { [GEMINI_API_KEY_ENV]: FAKE_API_KEY });
	const value = await resolveGoogleSearchCredential(ctx, Settings(undefined), undefined, {
		[GEMINI_API_KEY_ENV]: "from-process"
	});
	assert.equal(value, FAKE_API_KEY, "the Harness credential facility wins over the process env");
});

test("resolveGoogleSearchCredential: the launching environment is consulted before the process env", async () => {
	const ctx = new Context();
	new MockLaunchEnvironment(ctx, { [GEMINI_API_KEY_ENV]: FAKE_API_KEY });
	const value = await resolveGoogleSearchCredential(ctx, Settings(undefined), undefined, {
		[GEMINI_API_KEY_ENV]: "from-process"
	});
	assert.equal(value, FAKE_API_KEY, "the launching environment wins over the process env");
});

test("resolveGoogleSearchCredential: a blank literal falls through to the next source", async () => {
	const ctx = new Context();
	new MockCredentials(ctx, { [GEMINI_API_KEY_ENV]: FAKE_API_KEY });
	const value = await resolveGoogleSearchCredential(ctx, Settings(undefined), "   ", {});
	assert.equal(value, FAKE_API_KEY, "a blank literal is treated as absent");
});

test("resolveGoogleSearchCredential: the process env is the final fallback (bare provider path)", async () => {
	const value = await resolveGoogleSearchCredential(undefined, Settings(undefined), undefined, CONFIGURED_ENV);
	assert.equal(value, FAKE_API_KEY);
});

test("resolveGoogleSearchCredential: a custom apiKeyEnv names the variable everywhere", async () => {
	const ctx = new Context();
	new MockCredentials(ctx, { OTHER_GEMINI_KEY: FAKE_API_KEY });
	const value = await resolveGoogleSearchCredential(ctx, Settings({ apiKeyEnv: "OTHER_GEMINI_KEY" }), undefined, {});
	assert.equal(value, FAKE_API_KEY);
});

test("resolveGoogleSearchCredential: no source has a value → undefined (never a guess)", async () => {
	const value = await resolveGoogleSearchCredential(new Context(), Settings(undefined), undefined, {});
	assert.equal(value, undefined);
});

// ---------------------------------------------------------------------------
// available(): a resolution PATH exists (acceptance 3)
// ---------------------------------------------------------------------------

test("googleSearchConfigPathExists: true when the credential has a path", () => {
	const ctx = new Context();
	assert.equal(googleSearchConfigPathExists(ctx, Settings(undefined), undefined, CONFIGURED_ENV), true, "env value → path exists");
	assert.equal(googleSearchConfigPathExists(ctx, Settings(undefined), LITERAL_KEY, {}), true, "a literal key is a path");
	const credCtx = new Context();
	new MockCredentials(credCtx, {});
	assert.equal(googleSearchConfigPathExists(credCtx, Settings(undefined), undefined, {}), true, "a mounted credentials service is a path");
});

test("googleSearchConfigPathExists: false when the credential has no path", () => {
	const ctx = new Context();
	assert.equal(googleSearchConfigPathExists(ctx, Settings(undefined), undefined, {}), false, "no credential anywhere");
	assert.equal(googleSearchConfigPathExists(ctx, Settings(undefined), "  ", { [GEMINI_API_KEY_ENV]: "  " }), false, "a blank value is not a path");
});

// ---------------------------------------------------------------------------
// The provider: per-operation resolution + behavior settings (acceptance 1, 3)
// ---------------------------------------------------------------------------

test("search() resolves the credential per operation from the credentials service", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const ctx = new Context();
	new MockCredentials(ctx, { [GEMINI_API_KEY_ENV]: FAKE_API_KEY });
	const provider = buildGoogleSearchProvider({ ctx, settings: Settings(undefined), env: {}, transport });

	await provider.search({ query: "deepseek harness" });
	assert.equal(calls[0]!.request.headers["x-goog-api-key"], FAKE_API_KEY, "the credential service value is used");
});

test("search() uses the literal composition key when supplied (and it never enters settings)", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = buildGoogleSearchProvider({
		ctx: new Context(),
		settings: Settings(undefined),
		apiKey: LITERAL_KEY,
		env: {},
		transport
	});

	await provider.search({ query: "deepseek harness" });
	assert.equal(calls[0]!.request.headers["x-goog-api-key"], LITERAL_KEY, "the literal composition key authenticates the request");
});

test("search() with no resolution path fails MISSING_CREDENTIAL with an actionable message", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = buildGoogleSearchProvider({ ctx: new Context(), settings: Settings(undefined), env: {}, transport });

	const err = await expectWebError(provider.search({ query: "deepseek harness" }), "MISSING_CREDENTIAL");
	assert.match(err.message, new RegExp(GEMINI_API_KEY_ENV), "names the credential variable");
	assert.match(err.message, /apiKeyEnv|environment variable/i, "points at the setting to fix");
	assert.equal(calls.length, 0, "no transport call while unconfigured");
});

test("search() applies the configured model to the request", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = buildGoogleSearchProvider({
		env: CONFIGURED_ENV,
		transport,
		settings: defaultSettings({ model: "gemini-3.5-flash" })
	});

	await provider.search({ query: "deepseek harness" });
	assert.equal(calls[0]!.request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
});

test("search() uses the default model when the settings carry none", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = buildGoogleSearchProvider({ env: CONFIGURED_ENV, transport });

	await provider.search({ query: "q" });
	assert.equal(
		calls[0]!.request.url,
		`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SEARCH_DEFAULT_MODEL}:generateContent`
	);
});

test("search(): the caller's maxResults is not sent in the request (the grounding API has no count control)", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const provider = buildGoogleSearchProvider({ env: CONFIGURED_ENV, transport });
	await provider.search({ query: "q", maxResults: 3 });
	const body = parsedBody(calls[0]!.request);
	assert.equal(body["num"], undefined, "no result-count parameter is sent");
});

test("search(): a settings thunk is re-read per search (runtime changes apply)", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	let section = defaultSettings({ model: "gemini-3.6-flash" });
	const provider = buildGoogleSearchProvider({ env: CONFIGURED_ENV, transport, settings: () => section });

	await provider.search({ query: "q" });
	assert.equal(calls[0]!.request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
	section = defaultSettings({ model: "gemini-3.5-flash" });
	await provider.search({ query: "q" });
	assert.equal(calls[1]!.request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent", "the changed model applies");
});

test("search(): the provider-level requestTimeoutMs aborts a hung request with TIMEOUT", async () => {
	const transport = makeHangingTransport();
	const provider = buildGoogleSearchProvider({
		env: CONFIGURED_ENV,
		transport,
		settings: defaultSettings({ requestTimeoutMs: 1000 })
	});
	const err = await expectWebError(provider.search({ query: "q" }), "TIMEOUT");
	assert.match(err.message, /timed out/i);
});

test("search(): a credential resolved per operation is never cached (a later source change applies)", async () => {
	const { transport, calls } = makeTransport(() => ({ status: 200, body: SUCCESS_BODY }));
	const ctx = new Context();
	const credentials = new MockCredentials(ctx, { [GEMINI_API_KEY_ENV]: FAKE_API_KEY });
	const provider = buildGoogleSearchProvider({ ctx, settings: Settings(undefined), env: {}, transport });

	await provider.search({ query: "q" });
	assert.equal(calls[0]!.request.headers["x-goog-api-key"], FAKE_API_KEY);
	// The credential store changes; the next search must see the new value.
	(credentials as unknown as { values: Record<string, string> }).values[GEMINI_API_KEY_ENV] = "rotated-key-000";
	await provider.search({ query: "q" });
	assert.equal(calls[1]!.request.headers["x-goog-api-key"], "rotated-key-000", "no caching: the fresh value is used");
});

// ---------------------------------------------------------------------------
// The plugin: Config on the object + settings section wiring (acceptance 1)
// ---------------------------------------------------------------------------

test("the plugin carries the Config schema (validated by the Harness at load)", () => {
	assert.ok(googleSearchPlugin.Config, "the plugin object carries its Config schema");
	const result = validateConfig({});
	assert.ok(!result.issues, "an empty config validates (all fields have defaults)");
	assert.deepEqual(result.value, Config(undefined));
});

test("the plugin loads with an explicit config and searches with it", async () => {
	// The provider is built with no options: its transport is the global
	// fetch, so stub it (no network, no live credential).
	const realFetch = globalThis.fetch;
	const fetchCalls: { url: string; headers: Record<string, string> }[] = [];
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		fetchCalls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
		return new Response(SUCCESS_BODY, { status: 200 });
	}) as typeof fetch;
	try {
		const ctx = new Context();
		new WebRuntime(ctx);
		const fiber = ctx.plugin(googleSearchPlugin, {
			apiKey: LITERAL_KEY
		});
		await fiber;

		const result = await ctx.web.search({ query: "deepseek harness" });
		assert.equal(result.sources.length, 1, "the literal key drives the search");
		assert.equal(fetchCalls.length, 1, "exactly one request was made");
		assert.equal(fetchCalls[0]!.headers["x-goog-api-key"], LITERAL_KEY, "the literal config key authenticates the request");
		assert.ok(!fetchCalls[0]!.url.includes(LITERAL_KEY), "the URL never carries the credential");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("the plugin loads with an invalid config and fails at load (stable validation)", async () => {
	const ctx = new Context();
	new WebRuntime(ctx);
	const fiber = ctx.plugin(googleSearchPlugin, { model: "a/b" });
	// Config validation runs when the fiber starts, so an invalid model name
	// rejects the fiber at load, not at search time.
	await assert.rejects(
		() => Promise.resolve(fiber),
		/ValidationError|model/,
		"an invalid model name is rejected at load, not at search time"
	);
});

test("the settings section is registered while a settings service is mounted", async () => {
	const { dir, file } = await makeTempDir();
	const ctx = new Context();
	new WebRuntime(ctx);
	new FileSettingsProvider(ctx, { path: file, dshHome: dir, watch: false });
	const fiber = ctx.plugin(googleSearchPlugin, {});
	await fiber;

	const descriptor = ctx.settings.describe({ redactSecrets: true }).find((d) => d.ns === GOOGLE_SEARCH_SETTINGS_NAMESPACE);
	assert.ok(descriptor, "the google-search settings section is registered");
	assert.equal((descriptor!.value as Record<string, unknown>).apiKey, undefined, "the wire value carries no key");
});

// ---------------------------------------------------------------------------
// resolveGoogleSearchConfig (the env-only path) — post-migration contract
// ---------------------------------------------------------------------------

test("resolveGoogleSearchConfig: the credential present and non-blank → config", () => {
	const { config, missing } = resolveGoogleSearchConfig(CONFIGURED_ENV);
	assert.deepEqual(missing, []);
	assert.deepEqual(config, { apiKey: FAKE_API_KEY });
});

test("resolveGoogleSearchConfig: an absent or blank value is missing (names, never values)", () => {
	assert.deepEqual(resolveGoogleSearchConfig({}).missing, [GEMINI_API_KEY_ENV]);
	assert.deepEqual(resolveGoogleSearchConfig({ [GEMINI_API_KEY_ENV]: "  " }).missing, [GEMINI_API_KEY_ENV]);
});
