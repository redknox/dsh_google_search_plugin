/**
 * Issue #2 acceptance tests: the plugin loads through public DSH/Cordis
 * contracts, the harness can discover the search tool, the tool's input and
 * output are provider-neutral, and teardown is lifecycle-safe.
 *
 * No network, no Google, no credentials — a bare Cordis `Context` with the
 * two required services, exactly as the public contracts allow.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";

import { googleSearchPlugin, WEB_SEARCH_TOOL_NAME } from "../src/index.js";
import { SearchError, isSearchError } from "../src/domain/index.js";

/**
 * Build a fresh harness context the way a real deployment would: root
 * context, the two services the plugin `inject`s, then load the plugin
 * through the public `ctx.plugin()` contract.
 */
async function loadPlugin() {
	const ctx = new Context();
	new SystemPrompt(ctx, {});
	new ToolRuntime(ctx);
	const fiber = ctx.plugin(googleSearchPlugin);
	await fiber;
	return { ctx, fiber };
}

/** Collect every string token in a JSON value for the neutrality scan. */
function jsonTokens(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		out.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) jsonTokens(item, out);
	} else if (typeof value === "object" && value !== null) {
		for (const [k, v] of Object.entries(value)) {
			out.push(k);
			jsonTokens(v, out);
		}
	}
	return out;
}

/** Google-specific wire field names that must never appear in the tool contract. */
const GOOGLE_WIRE_FIELDS = [
	"cx",
	"key",
	"num",
	"q",
	"safe",
	"hl",
	"gl",
	"searchType",
	"siteSearch",
	"dateRestrict",
	"fileType",
	"rights"
];

test("plugin shape: object plugin with name and inject", () => {
	assert.equal(typeof googleSearchPlugin, "object");
	assert.equal(googleSearchPlugin.name, "google-search");
	assert.deepEqual(googleSearchPlugin.inject, ["tools", "systemPrompt"]);
	assert.equal(typeof googleSearchPlugin.apply, "function");
});

test("loads through public contracts; harness discovers web_search", async () => {
	const { ctx } = await loadPlugin();

	const tool = ctx.tools.get(WEB_SEARCH_TOOL_NAME);
	assert.notEqual(tool, undefined, "web_search must be discoverable by name");
	assert.equal(tool!.name, WEB_SEARCH_TOOL_NAME);
	assert.equal(typeof tool!.description, "string");
	assert.ok(tool!.description.length > 0);

	const schema = ctx.tools.schemas().find((s) => s.name === WEB_SEARCH_TOOL_NAME);
	assert.notEqual(schema, undefined, "web_search must appear in the model-facing schema list");
});

test("input schema exposes no Google-specific wire fields", async () => {
	const { ctx } = await loadPlugin();
	const tool = ctx.tools.get(WEB_SEARCH_TOOL_NAME)!;

	const parameters = tool.parameters as {
		type: string;
		properties: Record<string, { type: string }>;
		required?: string[];
	};
	assert.equal(parameters.type, "object");
	assert.deepEqual(Object.keys(parameters.properties).sort(), [
		"language",
		"limit",
		"query",
		"region",
		"safeSearch"
	]);

	// Standard JSON Schema: `query` is the only required field.
	assert.deepEqual(parameters.required, ["query"]);

	// No Google wire field name anywhere in the parameter schema.
	const tokens = jsonTokens(tool.parameters);
	for (const field of GOOGLE_WIRE_FIELDS) {
		assert.ok(!tokens.includes(field), `input schema must not mention Google wire field "${field}"`);
	}
});

test("output schema is provider-neutral", async () => {
	const { ctx } = await loadPlugin();
	const tool = ctx.tools.get(WEB_SEARCH_TOOL_NAME)!;
	const tokens = jsonTokens(tool.output.schema);
	for (const field of GOOGLE_WIRE_FIELDS) {
		assert.ok(!tokens.includes(field), `output schema must not mention Google wire field "${field}"`);
	}
});

test("execute fails with a structured capability_unavailable error (no backend wired yet)", async () => {
	const { ctx } = await loadPlugin();
	const tool = ctx.tools.get(WEB_SEARCH_TOOL_NAME)!;

	await assert.rejects(
		() => tool.execute({ query: "deepseek harness" }, {} as never),
		(err: unknown) => {
			assert.ok(isSearchError(err), "failure must be a structured SearchError, got: " + String(err));
			const se = err as SearchError;
			assert.equal(se.code, "capability_unavailable");
			assert.equal(se.name, "SearchError");
			return true;
		}
	);
});

test("execute rejects semantically invalid input with a structured invalid_request error", async () => {
	const { ctx } = await loadPlugin();
	const tool = ctx.tools.get(WEB_SEARCH_TOOL_NAME)!;

	// A whitespace-only query is structurally a valid string (passes the
	// defineTool wrapper) but semantically invalid (fails domain validation).
	await assert.rejects(
		() => tool.execute({ query: "   " }, {} as never),
		(err: unknown) => {
			assert.ok(isSearchError(err), "failure must be a structured SearchError, got: " + String(err));
			assert.equal((err as SearchError).code, "invalid_request");
			return true;
		}
	);
});

test("teardown: disposing the plugin fiber unregisters the tool", async () => {
	const { ctx, fiber } = await loadPlugin();
	assert.notEqual(ctx.tools.get(WEB_SEARCH_TOOL_NAME), undefined, "precondition: registered");

	await fiber.dispose();
	assert.equal(ctx.tools.get(WEB_SEARCH_TOOL_NAME), undefined, "tool must be unregistered after fiber dispose");
});
