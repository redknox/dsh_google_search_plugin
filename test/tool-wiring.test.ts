/**
 * Issue #5 acceptance tests — the Google backend wired into the Harness tool
 * contract, end to end.
 *
 * This is the **integration** half of the plugin's story. `google.test.ts`
 * and `normalize.test.ts` prove the *adapter* (Google wire → seam types) and
 * `registration.test.ts` proves the *provider registration* on the seam. This
 * file composes the **real** model-facing tool stack on top of the real seam
 * and the real Google provider, and drives the tool through the registry's
 * public `ctx.tools.execute(...)` entry point — exactly the path the Harness
 * agent loop takes:
 *
 *   model args → `web_search` tool (dsh-tool-web) → `ctx.web.search()` (dsh-web
 *   seam) → Google `WebSearchProvider` (this plugin) → mock transport
 *
 * The tool, the registry, the seam, and the timeout policy are the **real
 * published DSH packages** (`@deepseek-ai/dsh-tool-web`, `@deepseek-ai/dsh-tools`,
 * `@deepseek-ai/dsh-web`, `@deepseek-ai/dsh-tool-call-timeout-policy`). The only
 * thing mocked is the HTTP transport (an injected `GoogleHttpTransport`), so the
 * suite is fully offline and needs no live credential (ENGINEERING.md §8).
 *
 * The plugin stays **provider-only** (ARCHITECTURE.md): it supplies the search
 * backend; it does not own the `web_search` tool. This file composes the tool
 * from `dsh-tool-web` *alongside* the plugin to prove the wiring, and asserts
 * the tool contract remains Google-neutral (acceptance 2).
 *
 * Acceptance mapping (issue #5):
 *   1. Harness invokes the tool and receives normalized ranked results
 *        → "single query success", "maxResults bound", "multi-query merge"
 *   2. Tool contract remains Google-neutral
 *        → "the web_search tool contract is Google-neutral"
 *   3. Raw Google DTOs/errors never cross the provider boundary
 *        → "provider failure → stable tool-visible error (no raw payload)"
 *   4. Cancellation and timeout propagate end-to-end
 *        → "caller cancellation", "tool-call timeout"
 *   5. Plugin lifecycle stays clean after repeated calls
 *        → "repeated calls + teardown"
 *   6. Tests cover success and important error paths
 *        → success, empty, invalid input, provider failure, timeout, cancel
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import { ToolRuntime, type ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as toolWeb from "@deepseek-ai/dsh-tool-web";
import * as timeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { CallId } from "@deepseek-ai/dsh-llm";

import { buildGoogleSearchProvider } from "../src/index.js";
import {
	GOOGLE_SEARCH_API_KEY_ENV,
	GOOGLE_SEARCH_ENGINE_ID_ENV
} from "../src/provider/config.js";
import type { GoogleHttpTransport, GoogleHttpResponse } from "../src/provider/transport.js";

// ---------------------------------------------------------------------------
// Fixtures — fake values only; never a real credential (acceptance 6).
// ---------------------------------------------------------------------------

const FAKE_API_KEY = "fake-api-key-000";
const FAKE_CX = "fake-cx-000";

const CONFIG_ENV: Record<string, string | undefined> = {
	[GOOGLE_SEARCH_API_KEY_ENV]: FAKE_API_KEY,
	[GOOGLE_SEARCH_ENGINE_ID_ENV]: FAKE_CX
};

/** One recorded transport call: the serialized URL and the forwarded signal. */
interface RecordedCall {
	url: string;
	signal?: AbortSignal | undefined;
}

/**
 * Build a mock `GoogleHttpTransport` that records every call (URL + the
 * forwarded `AbortSignal`) and delegates to a handler. This is the single
 * injected seam that keeps the suite offline.
 */
function makeTransport(handler: (url: string, signal?: AbortSignal) => Promise<GoogleHttpResponse>) {
	const calls: RecordedCall[] = [];
	const transport: GoogleHttpTransport = async (url, signal) => {
		calls.push({ url, signal });
		return handler(url, signal);
	};
	return { transport, calls };
}

/** A realistic Google Custom Search success body with `n` result items. */
function googleSuccessBody(n: number): string {
	const items = Array.from({ length: n }, (_, i) => ({
		title: `Result ${i + 1}`,
		link: `https://example.com/${i + 1}`,
		snippet: `Snippet text for result ${i + 1}.`
	}));
	return JSON.stringify({ kind: "customsearch#search", items });
}

/** A realistic Google zero-result body: `items` is ABSENT (not malformed). */
const GOOGLE_EMPTY_BODY = JSON.stringify({
	kind: "customsearch#search",
	queries: { request: [{ q: "zzz", totalResults: "0" }] },
	searchInformation: { totalResults: "0" }
});

/** A Google non-2xx error body with a documented `reason`. */
function googleErrorBody(status: number, reason: string, message: string): string {
	return JSON.stringify({
		error: {
			code: status,
			message,
			status: String(status),
			errors: [{ reason, message }]
		}
	});
}

/**
 * The `web_search` tool's declared output contract: the stable, Google-neutral
 * shape the registry validates every successful value against.
 */
interface WebSearchToolValue {
	content?: string;
	sources: { url: string; title?: string; snippet?: string; publishedAt?: string }[];
	truncated: boolean;
}

/** The `web_search` tool config: search enabled, fetch disabled, small budget. */
interface ToolWebConfig {
	search: boolean;
	fetch: boolean;
	searchMaxResults: number;
	searchMaxQueries: number;
	searchTimeoutMs: number;
}

/**
 * Compose the full tool stack the way a real deployment does: the three
 * services the tool requires (`systemPrompt`, `tools`, `web`), the
 * cooperative-timeout policy, and the `web_search` tool — then register the
 * **real** Google provider (with the injected mock transport) on the seam.
 *
 * `searchMaxResults` is set to 5 so the seam's `maxResults` enforcement is
 * observable (the API would otherwise return up to 10).
 */
async function buildHarness(
	transport: GoogleHttpTransport,
	toolConfig: ToolWebConfig
): Promise<Context> {
	const ctx = new Context();
	new SystemPrompt(ctx, {});
	new ToolRuntime(ctx, {});
	new WebRuntime(ctx, {});

	// The two tool-side plugins are function plugins; wrap them in object
	// plugin shapes so the config is passed positionally and explicitly.
	const timeoutPlugin: Plugin.Object = {
		name: timeoutPolicy.name,
		inject: timeoutPolicy.inject,
		apply: timeoutPolicy.apply
	};
	const toolWebPlugin: Plugin.Object = {
		name: toolWeb.name,
		inject: toolWeb.inject,
		// Carry the real config schema so cordis resolves the tool's defaults
		// (fetchTimeoutMs, fetchMaxOutputChars, …) exactly as a real deployment
		// would — the test only overrides the search fields it cares about.
		Config: toolWeb.Config,
		apply: toolWeb.apply
	};
	await ctx.plugin(timeoutPlugin);
	await ctx.plugin(toolWebPlugin, toolConfig);

	// The plugin under test supplies the backend; the tool above consumes it.
	ctx.web.registerSearchProvider(
		buildGoogleSearchProvider({ env: CONFIG_ENV, transport })
	);
	return ctx;
}

/** Invoke the `web_search` tool through the registry's public entry point. */
async function runWebSearch(
	ctx: Context,
	queries: string[],
	signal: AbortSignal
): Promise<ToolExecutionResult> {
	return ctx.tools.execute({
		callId: CallId("web-search"),
		name: "web_search",
		arguments: { queries },
		signal
	});
}

const DEFAULT_TOOL_CONFIG: ToolWebConfig = {
	search: true,
	fetch: false,
	searchMaxResults: 5,
	searchMaxQueries: 4,
	searchTimeoutMs: 30_000
};

// ---------------------------------------------------------------------------
// 1. Success: the tool returns normalized, ranked sources
// ---------------------------------------------------------------------------

test("single query success: the tool returns normalized ranked sources", async () => {
	const { transport, calls } = makeTransport(async () => ({
		status: 200,
		body: googleSuccessBody(3)
	}));
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	const result = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);

	assert.equal(result.isError, false, `expected success, got: ${JSON.stringify(result.error)}`);
	const value = result.value as unknown as WebSearchToolValue;
	assert.equal(value.truncated, false);
	assert.equal(value.sources.length, 3);
	// Ranked order is preserved from the provider (Google returns ranked items).
	assert.deepEqual(
		value.sources.map((s) => s.url),
		["https://example.com/1", "https://example.com/2", "https://example.com/3"]
	);
	// The normalized source carries only the seam's fields, mapped from Google.
	assert.deepEqual(value.sources[0], {
		url: "https://example.com/1",
		title: "Result 1",
		snippet: "Snippet text for result 1."
	});

	// The request went through the seam to exactly one Google call, with the
	// tool's `searchMaxResults` bound applied at the request layer as `num`.
	assert.equal(calls.length, 1);
	const params = new URL(calls[0]!.url).searchParams;
	assert.equal(params.get("q"), "deepseek harness");
	assert.equal(params.get("num"), "5", "the tool's maxResults bound is sent as num");
	assert.equal(params.get("key"), FAKE_API_KEY);
	assert.equal(params.get("cx"), FAKE_CX);
});

test("maxResults bound: the seam truncates an over-returning provider and flags it", async () => {
	// The provider returns 8 sources; the tool asks for 5. The seam enforces
	// the bound and sets truncated (the adapter itself always reports false).
	const { transport } = makeTransport(async () => ({
		status: 200,
		body: googleSuccessBody(8)
	}));
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	const result = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);
	assert.equal(result.isError, false, `expected success, got: ${JSON.stringify(result.error)}`);
	const value = result.value as unknown as WebSearchToolValue;
	assert.equal(value.sources.length, 5, "the seam caps the sources at maxResults");
	assert.equal(value.truncated, true, "the seam flags the truncated result");
});

test("multi-query merge: concurrent queries are deduped, ranked round-robin, and capped", async () => {
	// Two queries; the second returns a source the first also returned (same
	// url) to exercise dedup, plus a fresh one.
	let queryIndex = 0;
	const { transport } = makeTransport(async (url) => {
		queryIndex += 1;
		const q = new URL(url).searchParams.get("q");
		const body =
			q === "alpha"
				? JSON.stringify({
						items: [
							{ title: "A1", link: "https://example.com/a1" },
							{ title: "Shared", link: "https://example.com/shared" }
						]
					})
				: JSON.stringify({
						items: [
							{ title: "Shared", link: "https://example.com/shared" },
							{ title: "B1", link: "https://example.com/b1" }
						]
					});
		return { status: 200, body };
	});
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	const result = await runWebSearch(ctx, ["alpha", "beta"], new AbortController().signal);
	assert.equal(result.isError, false, `expected success, got: ${JSON.stringify(result.error)}`);
	const value = result.value as unknown as WebSearchToolValue;
	// Round-robin by rank: A1, Shared, B1 (the duplicate Shared is dropped).
	assert.deepEqual(
		value.sources.map((s) => s.url),
		["https://example.com/a1", "https://example.com/shared", "https://example.com/b1"]
	);
	assert.equal(value.sources.length, 3);
	assert.equal(value.truncated, false);
	assert.equal(queryIndex, 2, "each query issued its own Google call");
});

// ---------------------------------------------------------------------------
// 2. The tool contract remains Google-neutral
// ---------------------------------------------------------------------------

test("the web_search tool contract is Google-neutral", async () => {
	const { transport } = makeTransport(async () => ({
		status: 200,
		body: googleSuccessBody(1)
	}));
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	const definition = ctx.tools.get("web_search");
	assert.ok(definition, "the web_search tool is registered by dsh-tool-web");

	// The model-facing schema is the tool's own: a `queries` array. No Google
	// parameter (`key`, `cx`, `q`, `num`), endpoint, or wire field name appears
	// in the tool's name, description, or parameter schema.
	const schemaText = JSON.stringify({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters
	});
	for (const googleToken of [
		"customsearch",
		"googleapis",
		"GOOGLE_SEARCH",
		FAKE_CX,
		FAKE_API_KEY
	]) {
		assert.ok(
			!schemaText.includes(googleToken),
			`the tool contract must not mention Google internals, but it contains: ${googleToken}`
		);
	}
	// The tool asks for `queries` (its own vocabulary), not a Google query
	// parameter (`q`): the parameter schema exposes exactly one property.
	const parameters = definition.parameters as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	assert.deepEqual(
		Object.keys(parameters.properties ?? {}),
		["queries"],
		"the tool's only parameter is `queries`, not a Google wire field"
	);
	assert.deepEqual(parameters.required, ["queries"]);
});

// ---------------------------------------------------------------------------
// 3. Provider failures become stable tool-visible errors (no raw payload)
// ---------------------------------------------------------------------------

test("provider failure: a 5xx becomes a stable structured error, never the raw Google payload", async () => {
	const { transport } = makeTransport(async () => ({
		status: 503,
		body: googleErrorBody(503, "backendError", "upstream down")
	}));
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	const result = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);

	assert.equal(result.isError, true, "a provider failure surfaces as a tool error");
	const error = result.error;
	// The structured code is the stable, machine-routable one (from the
	// adapter's taxonomy), not a free-text Google status.
	assert.equal(error.info?.code, "PROVIDER_FAILURE");
	// The message is the adapter's stable description — it carries the HTTP
	// status and reason, but never the raw Google body, the request URL, or
	// the credential.
	assert.match(error.message, /HTTP 503/);
	assert.match(error.message, /backendError/);
	assert.ok(
		!error.message.includes(FAKE_API_KEY) && !error.message.includes(FAKE_CX),
		`the credential must not leak into the tool-visible message: ${error.message}`
	);
	assert.ok(
		!error.message.includes("customsearch.googleapis.com"),
		"the request URL (which carries the credential) must not leak into the message"
	);
});

test("provider failure: an invalid-credential 400 maps to the stable INVALID_CREDENTIAL code", async () => {
	const { transport } = makeTransport(async () => ({
		status: 400,
		body: googleErrorBody(400, "badRequest", "API key not valid. Please pass a valid API key.")
	}));
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	const result = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);
	assert.equal(result.isError, true);
	assert.equal(result.error.info?.code, "INVALID_CREDENTIAL");
	assert.ok(!result.error.message.includes(FAKE_API_KEY), "no credential in the message");
});

test("provider failure: quota and rate-limit map to their stable shared codes", async () => {
	const quotaBody = googleErrorBody(403, "quotaExceeded", "Quota exceeded for quota metric 'Search'");
	const rateBody = googleErrorBody(429, "rateLimitExceeded", "Rate limit exceeded");

	const quota = await makeTransport(async () => ({ status: 403, body: quotaBody }));
	const quotaCtx = await buildHarness(quota.transport, DEFAULT_TOOL_CONFIG);
	const quotaResult = await runWebSearch(quotaCtx, ["q"], new AbortController().signal);
	assert.equal(quotaResult.isError, true);
	assert.equal(quotaResult.error.info?.code, "QUOTA");

	const rate = await makeTransport(async () => ({ status: 429, body: rateBody }));
	const rateCtx = await buildHarness(rate.transport, DEFAULT_TOOL_CONFIG);
	const rateResult = await runWebSearch(rateCtx, ["q"], new AbortController().signal);
	assert.equal(rateResult.isError, true);
	assert.equal(rateResult.error.info?.code, "RATE_LIMIT");
});

// ---------------------------------------------------------------------------
// 6 (success/empty paths): empty results are a success, not an error
// ---------------------------------------------------------------------------

test("empty results: a zero-result Google response is a successful empty result", async () => {
	const { transport } = makeTransport(async () => ({ status: 200, body: GOOGLE_EMPTY_BODY }));
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	const result = await runWebSearch(ctx, ["zzz"], new AbortController().signal);
	assert.equal(result.isError, false, "an empty result is a success, not an error");
	const value = result.value as unknown as WebSearchToolValue;
	assert.deepEqual(value.sources, []);
	assert.equal(value.truncated, false);
});

// ---------------------------------------------------------------------------
// 6 (invalid input): the tool validates before any provider round-trip
// ---------------------------------------------------------------------------

test("invalid input: an empty queries array fails before any Google call", async () => {
	const { transport, calls } = makeTransport(async () => ({
		status: 200,
		body: googleSuccessBody(1)
	}));
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	const result = await runWebSearch(ctx, [], new AbortController().signal);
	assert.equal(result.isError, true, "an empty queries array is an invalid tool call");
	assert.match(result.error.message, /queries must contain at least one query/);
	assert.equal(calls.length, 0, "no Google request is made for invalid input");
});

test("invalid input: more queries than the bound fail before any Google call", async () => {
	const { transport, calls } = makeTransport(async () => ({
		status: 200,
		body: googleSuccessBody(1)
	}));
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG); // searchMaxQueries: 4

	const result = await runWebSearch(
		ctx,
		["a", "b", "c", "d", "e"],
		new AbortController().signal
	);
	assert.equal(result.isError, true);
	assert.match(result.error.message, /at most 4 queries/);
	assert.equal(calls.length, 0, "no Google request is made for invalid input");
});

// ---------------------------------------------------------------------------
// 4. Cancellation and timeout propagate end-to-end
// ---------------------------------------------------------------------------

/**
 * A transport that behaves like a real `fetch` with respect to cancellation:
 * it waits until the forwarded signal aborts, then rejects with an
 * `AbortError` (the name `fetch` uses). This proves the signal is genuinely
 * forwarded from the tool, through the seam, to the provider transport.
 */
function abortingTransport(handler?: (url: string, signal?: AbortSignal) => Promise<GoogleHttpResponse>) {
	return makeTransport(async (url, signal) => {
		if (handler) return handler(url, signal);
		await new Promise<void>((resolve, reject) => {
			if (signal?.aborted) {
				reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
				return;
			}
			signal?.addEventListener(
				"abort",
				() => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
				{ once: true }
			);
		});
		throw new Error("unreachable");
	});
}

test("caller cancellation: the forwarded signal aborts the provider transport", async () => {
	const { transport, calls } = abortingTransport();
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	const controller = new AbortController();
	const pending = runWebSearch(ctx, ["deepseek harness"], controller.signal);
	// Let the request start, then cancel from the caller side.
	setTimeout(() => controller.abort(), 20);
	const result = await pending;

	assert.equal(result.isError, true, "a cancelled call is an error");
	// The tool-visible code is the stable cancellation code the adapter emits.
	assert.equal(result.error.info?.code, "ABORTED");
	// The signal was actually forwarded to the transport and aborted there.
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.signal?.aborted, true, "the forwarded signal aborted the transport call");
});

test("tool-call timeout: the cooperative budget aborts the provider transport", async () => {
	// A 40ms budget; the transport only settles when the signal aborts, so the
	// deadline (not the provider) wins.
	const { transport, calls } = abortingTransport();
	const ctx = await buildHarness(
		transport,
		{ ...DEFAULT_TOOL_CONFIG, searchTimeoutMs: 40 }
	);

	const started = Date.now();
	const result = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);
	const elapsed = Date.now() - started;

	// The cooperative timeout policy owns the timeout outcome: a stable
	// TOOL_TIMEOUT error, not the raw provider error and not a hang.
	assert.equal(result.isError, true);
	assert.equal(result.error.info?.code, "TOOL_TIMEOUT");
	assert.match(result.error.message, /timed out after 40ms/);
	// The deadline aborted the forwarded signal, which cancelled the transport.
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.signal?.aborted, true, "the timeout signal aborted the transport call");
	assert.ok(elapsed < 5_000, `the call settled promptly on timeout (took ${elapsed}ms)`);
});

// ---------------------------------------------------------------------------
// 5. Plugin lifecycle stays clean after repeated calls
// ---------------------------------------------------------------------------

test("repeated calls: the tool and provider stay consistent across many invocations", async () => {
	const { transport, calls } = makeTransport(async () => ({
		status: 200,
		body: googleSuccessBody(2)
	}));
	const ctx = await buildHarness(transport, DEFAULT_TOOL_CONFIG);

	for (let i = 0; i < 5; i++) {
		const result = await runWebSearch(ctx, [`query ${i}`], new AbortController().signal);
		assert.equal(result.isError, false, `call ${i} should succeed`);
		const value = result.value as unknown as WebSearchToolValue;
		assert.equal(value.sources.length, 2);
	}
	assert.equal(calls.length, 5, "each call issues exactly one Google request");
	// The provider is still registered and available after the burst.
	assert.equal(ctx.tools.get("web_search") !== undefined, true, "the tool is still registered");
});

test("teardown: disposing the provider fiber leaves the tool registered but degrading cleanly", async () => {
	// The full tool stack, plus the provider registered the way the plugin's
	// `apply` does it — through a fiber whose fiber-scoped disposer the seam
	// runs on unload (with the mock transport injected).
	const ctx = new Context();
	new SystemPrompt(ctx, {});
	new ToolRuntime(ctx, {});
	new WebRuntime(ctx, {});
	const timeoutPlugin: Plugin.Object = {
		name: timeoutPolicy.name,
		inject: timeoutPolicy.inject,
		apply: timeoutPolicy.apply
	};
	const toolWebPlugin: Plugin.Object = {
		name: toolWeb.name,
		inject: toolWeb.inject,
		// Carry the real config schema so cordis resolves the tool's defaults
		// (fetchTimeoutMs, fetchMaxOutputChars, …) exactly as a real deployment
		// would — the test only overrides the search fields it cares about.
		Config: toolWeb.Config,
		apply: toolWeb.apply
	};
	await ctx.plugin(timeoutPlugin);
	await ctx.plugin(toolWebPlugin, DEFAULT_TOOL_CONFIG);

	const { transport } = makeTransport(async () => ({
		status: 200,
		body: googleSuccessBody(1)
	}));
	const fiber = ctx.plugin({
		name: "google-search-test",
		inject: ["web"],
		apply: (c: Context) => {
			c.web.registerSearchProvider(
				buildGoogleSearchProvider({ env: CONFIG_ENV, transport })
			);
		}
	});
	await fiber;

	// Precondition: the tool works while the provider is registered.
	const before = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);
	assert.equal(before.isError, false, `expected success before teardown, got: ${JSON.stringify(before.error)}`);

	// Unload the provider's fiber: the seam's fiber-scoped disposer must
	// unregister the provider. The tool (owned by dsh-tool-web, not this
	// plugin) must stay registered and degrade with a stable, structured
	// error — no crash, no leaked provider state.
	await fiber.dispose();
	assert.ok(ctx.tools.get("web_search"), "the tool stays registered after provider teardown");
	const after = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);
	assert.equal(after.isError, true, "after teardown the tool reports a structured error");
	assert.equal(after.error.info?.code, "WEB_PROVIDER_UNAVAILABLE");
});

test("teardown: with no usable provider the tool reports a stable unavailability error", async () => {
	// A context with the full tool stack but NO search provider registered:
	// the tool stays registered and fails with the seam's stable
	// no-usable-provider code — a clean, structured degradation.
	const ctx = new Context();
	new SystemPrompt(ctx, {});
	new ToolRuntime(ctx, {});
	new WebRuntime(ctx, {});
	const timeoutPlugin: Plugin.Object = {
		name: timeoutPolicy.name,
		inject: timeoutPolicy.inject,
		apply: timeoutPolicy.apply
	};
	const toolWebPlugin: Plugin.Object = {
		name: toolWeb.name,
		inject: toolWeb.inject,
		// Carry the real config schema so cordis resolves the tool's defaults
		// (fetchTimeoutMs, fetchMaxOutputChars, …) exactly as a real deployment
		// would — the test only overrides the search fields it cares about.
		Config: toolWeb.Config,
		apply: toolWeb.apply
	};
	await ctx.plugin(timeoutPlugin);
	await ctx.plugin(toolWebPlugin, DEFAULT_TOOL_CONFIG);

	assert.ok(ctx.tools.get("web_search"), "the tool is registered even with no provider");
	const result = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);
	assert.equal(result.isError, true);
	assert.equal(result.error.info?.code, "WEB_PROVIDER_UNAVAILABLE");
});
