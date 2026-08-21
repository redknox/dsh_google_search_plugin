/**
 * Issue #2 acceptance tests — provider-only (ARCHITECTURE.md).
 *
 * The plugin registers a `WebSearchProvider` on the `ctx.web` seam
 * (`@deepseek-ai/dsh-web`). Registration and unload are verified **through
 * the seam's public API** — its provider-selection error codes — never by
 * reaching into private registry internals, and never by asserting a
 * plugin-owned tool (the `web_search` tool is owned by
 * `@deepseek-ai/dsh-tool-web`).
 *
 * No network, no Google, no credentials: the tests run with the Google
 * runtime-configuration environment variables **removed** (restored
 * afterwards), so the provider is deterministically in its *unconfigured*
 * state — registered, but `available()` false — exactly the state the seam
 * reports as `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`. The configured/available
 * path (and the real adapter behavior) is covered by `google.test.ts` with
 * an injected env source and a mock transport.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { after } from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { WebRuntime, WebError } from "@deepseek-ai/dsh-web";

import {
	googleSearchPlugin,
	buildGoogleSearchProvider,
	GOOGLE_SEARCH_PROVIDER_ID
} from "../src/index.js";
import { GOOGLE_SEARCH_API_KEY_ENV, GOOGLE_SEARCH_ENGINE_ID_ENV } from "../src/provider/config.js";

/**
 * Make the process environment hermetic for the duration of this file:
 * remove the Google runtime-configuration variables (saving any values the
 * developer's shell happened to set) so the plugin's provider is
 * deterministically *unconfigured*. Restored after the file finishes.
 */
const CONFIG_ENV_KEYS = [GOOGLE_SEARCH_API_KEY_ENV, GOOGLE_SEARCH_ENGINE_ID_ENV] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of CONFIG_ENV_KEYS) {
	savedEnv[key] = process.env[key];
	delete process.env[key];
}
after(() => {
	for (const key of CONFIG_ENV_KEYS) {
		if (savedEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = savedEnv[key];
		}
	}
});

/**
 * Build a fresh harness context the way a real deployment would: root
 * context, the one service the plugin `inject`s, then load the plugin
 * through the public `ctx.plugin()` contract.
 *
 * `pinSearchProvider` pins the seam's search-provider selection to a given
 * id (the same field an operator sets via `$DSH_WEB_SEARCH_PROVIDER`). With
 * the id pinned, the seam's distinct selection error codes become
 * observable proof of registration state:
 *   - id not registered          → `WEB_PROVIDER_CONFIGURED_MISSING`
 *   - id registered but `available()` false
 *                               → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`
 */
async function loadPlugin(pinSearchProvider?: string) {
	const ctx = new Context();
	new WebRuntime(ctx, pinSearchProvider ? { searchProvider: pinSearchProvider } : {});
	const fiber = ctx.plugin(googleSearchPlugin);
	await fiber;
	return { ctx, fiber };
}

/** Run one seam search and resolve to the thrown `WebError`'s code. */
async function seamSearchCode(ctx: Context): Promise<string> {
	try {
		await ctx.web.search({ query: "deepseek harness" });
	} catch (err) {
		assert.ok(err instanceof WebError, `seam search must throw a WebError, got: ${String(err)}`);
		return err.code;
	}
	assert.fail("seam search unexpectedly resolved with an unconfigured provider");
}

test("plugin shape: object plugin with name and inject", () => {
	assert.equal(typeof googleSearchPlugin, "object");
	assert.equal(googleSearchPlugin.name, "google-search");
	// The plugin requires only the `web` seam — not `tools` or `systemPrompt`,
	// because it owns no model-facing tool (that is dsh-tool-web's job).
	assert.deepEqual(googleSearchPlugin.inject, ["web"]);
	assert.equal(typeof googleSearchPlugin.apply, "function");
});

test("loads through public contracts; seam discovers the google provider", async () => {
	const { ctx } = await loadPlugin(GOOGLE_SEARCH_PROVIDER_ID);
	// The seam reports the provider as registered (it can find it by id) but
	// unavailable (the runtime configuration is absent in this hermetic
	// environment, so `available()` is false). This proves registration
	// through the seam's own selection logic, not a private registry lookup.
	assert.equal(
		await seamSearchCode(ctx),
		"WEB_PROVIDER_CONFIGURED_UNAVAILABLE"
	);
});

test("without the plugin the seam reports the configured provider as missing", async () => {
	// A context with the seam pinned to the google id but WITHOUT the plugin
	// loaded: the seam cannot find the provider, so it reports the
	// configured id as missing. This is the baseline the registration test
	// contrasts against.
	const ctx = new Context();
	new WebRuntime(ctx, { searchProvider: GOOGLE_SEARCH_PROVIDER_ID });
	assert.equal(await seamSearchCode(ctx), "WEB_PROVIDER_CONFIGURED_MISSING");
});

test("the plugin owns no model-facing tool (provider-only)", async () => {
	const { ctx } = await loadPlugin();
	// The plugin's `inject` does not require `tools`, so a context that
	// provides only `web` (as built above) is sufficient for it to load.
	// There is no `tools` service here at all — so the plugin cannot have
	// registered a tool. The `web_search` tool is owned by dsh-tool-web.
	assert.equal(
		(ctx as { tools?: unknown }).tools,
		undefined,
		"no tools service is present; the plugin must not require or create one"
	);
});

test("duplicate provider id is rejected by the seam", async () => {
	const { ctx } = await loadPlugin();
	// A second provider with the same id must be refused with a structured
	// seam error (duplicate ids are rejected by the seam contract).
	assert.throws(
		() => ctx.web.registerSearchProvider(buildGoogleSearchProvider({ env: {} })),
		(err: unknown) => {
			assert.ok(err instanceof WebError, `expected WebError, got: ${String(err)}`);
			return (err as WebError).code === "WEB_DUPLICATE_PROVIDER";
		}
	);
});

test("the unconfigured provider is unavailable and fails structured (no network)", async () => {
	const provider = buildGoogleSearchProvider({ env: {} });
	assert.equal(provider.id, GOOGLE_SEARCH_PROVIDER_ID);
	assert.equal(provider.available(), false, "provider is unavailable while the runtime configuration is absent");

	// A direct call (bypassing the seam) must fail with a structured
	// capability-unavailable error naming the missing variables — never a
	// fabricated empty success, and without performing any Google request.
	await assert.rejects(
		() => provider.search({ query: "deepseek harness" }),
		(err: unknown) => {
			assert.ok(err instanceof WebError, `expected WebError, got: ${String(err)}`);
			const webError = err as WebError;
			assert.equal(webError.code, "MISSING_CREDENTIAL");
			assert.match(webError.message, /GOOGLE_SEARCH_API_KEY/);
			assert.match(webError.message, /GOOGLE_SEARCH_ENGINE_ID/);
			return true;
		}
	);
});

test("seam auto-select reports the unconfigured provider as no-usable-provider", async () => {
	const { ctx } = await loadPlugin();
	// No id configured: the seam auto-selects. The single registered provider
	// is unconfigured (unavailable), so selection reports no usable provider.
	assert.equal(await seamSearchCode(ctx), "WEB_PROVIDER_UNAVAILABLE");
});

test("teardown: disposing the plugin fiber unregisters the provider", async () => {
	const { ctx, fiber } = await loadPlugin(GOOGLE_SEARCH_PROVIDER_ID);
	// Precondition: registered (seam finds it by id, but it is unavailable).
	assert.equal(
		await seamSearchCode(ctx),
		"WEB_PROVIDER_CONFIGURED_UNAVAILABLE"
	);

	// Unload the plugin's fiber: the seam's fiber-scoped disposer must
	// unregister the provider, so the same configured id is now *missing*.
	await fiber.dispose();
	assert.equal(await seamSearchCode(ctx), "WEB_PROVIDER_CONFIGURED_MISSING");
});
