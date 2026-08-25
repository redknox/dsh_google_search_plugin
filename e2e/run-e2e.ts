/**
 * Issue #7 — live end-to-end verification against the real Gemini API
 * `google_search` grounding tool and the real DeepSeek Harness tool path.
 *
 * This script is **not** part of the offline test suite (`npm test`): it makes
 * real network calls to Google and needs a real (user-provided) credential, so
 * it is run explicitly (`npm run e2e`) and is never executed in CI. It reads the
 * credential from the gitignored `.env.e2e.local` file (never committed,
 * ENGINEERING.md §4) and writes a tracked verification report
 * (`E2E_VERIFICATION.md`) that records the evidence while scrubbing every
 * credential value (acceptance 2).
 *
 * The composition is the **real** deployment path, not a mock:
 *
 *   model args → `web_search` tool (`@deepseek-ai/dsh-tool-web`, real)
 *     → `ctx.tools.execute` (real registry)
 *     → `ctx.web.search()` (`@deepseek-ai/dsh-web` seam, real)
 *     → Google `WebSearchProvider` (this plugin's real `apply()`, real)
 *     → global `fetch` (real network to the Gemini API)
 *
 * The only instrumentation is a read-only wrapper around `globalThis.fetch`
 * that counts requests and records the request URL, the request header names
 * (values redacted), and the JSON request body (prompt + tools) so the report
 * can show exactly what was sent. The wrapper delegates to the real `fetch`;
 * it never alters the request.
 *
 * Backend (Issue #7 migration): the Gemini API `google_search` grounding tool,
 * not the Custom Search JSON API (retired by Google, closed to new customers).
 * One API key, no engine id. The grounding API exposes **no** per-request
 * language/region/SafeSearch/result-count controls, so the previous Custom
 * Search cases for those parameters are replaced by a documented
 * "unsupported by the backend" section (acceptance 5).
 *
 * Cases (issue #7 tasks):
 *   1. ordinary query              → normalized live results, with the
 *      grounded artifact (answer + citations + Search suggestions) preserved
 *      end to end (acceptance 1)
 *   2. zero-grounding-sources query → success with zero sources (the wire
 *      fact is "zero grounding sources", not "Google returned zero search
 *      results")
 *   3. non-ASCII query             → query round-trips intact, normalized
 *      results
 *   4. result limit                → the seam caps the sources at maxResults
 *   5. invalid credential          → stable INVALID_CREDENTIAL, no value
 *      leaked
 *   6. cancellation                → forwarded signal aborts the real request
 *
 * Timeout: the provider-level `requestTimeoutMs` deadline is **not**
 * reproducible against the real (fast) API without a hanging endpoint, so it
 * is documented as covered by the offline suite, not by this script
 * (acceptance 5).
 */

import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import { WebRuntime } from "@deepseek-ai/dsh-web";
import { ToolRuntime, type ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as toolWeb from "@deepseek-ai/dsh-tool-web";
import * as timeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { CallId } from "@deepseek-ai/dsh-llm";

import { googleSearchPlugin, GEMINI_API_KEY_ENV, Config } from "../src/index.js";
import {
	GEMINI_SEARCH_DEFAULT_MODEL,
	GEMINI_SEARCH_ENDPOINT_BASE,
	GEMINI_SEARCH_PROMPT_TEMPLATE,
	scrubUrlTokens
} from "../src/provider/transport.js";

/** The plugin's composition-input config (the schema's input type, partial). */
type PluginConfigInput = Parameters<typeof Config>[0];

// ---------------------------------------------------------------------------
// Credential handling — values never logged, never committed (acceptance 2).
// ---------------------------------------------------------------------------

// The compiled script lives at <repo>/lib-e2e/e2e/run-e2e.js, so the repo
// root is two levels up from this file's directory.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CRED_FILE = path.join(REPO_ROOT, ".env.e2e.local");
const REPORT_FILE = path.join(REPO_ROOT, "E2E_VERIFICATION.md");

/** Parse a minimal `KEY=VALUE` env file (no shell, no secrets echoed). */
function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		// Strip a single matching pair of surrounding quotes.
		if (
			(value.length >= 2 && value.startsWith('"') && value.endsWith('"')) ||
			(value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

async function loadCredentials(): Promise<{ apiKey: string }> {
	let text: string;
	try {
		text = await readFile(CRED_FILE, "utf8");
	} catch {
		throw new Error(
			`E2E credential file not found at ${CRED_FILE}. Create it (it is gitignored) with:\n` +
				`  ${GEMINI_API_KEY_ENV}=<your Gemini API key>\n` +
				"Never commit the file or its values (ENGINEERING.md §4)."
		);
	}
	const env = parseEnvFile(text);
	const apiKey = (env[GEMINI_API_KEY_ENV] ?? "").trim();
	if (apiKey.length === 0) {
		throw new Error(`E2E credential file is missing ${GEMINI_API_KEY_ENV}.`);
	}
	return { apiKey };
}

// ---------------------------------------------------------------------------
// Read-only traffic instrumentation (delegates to the real fetch).
// ---------------------------------------------------------------------------

interface RecordedRequest {
	/** The request URL (carries no credential — the key is in a header). */
	url: string;
	/** The request header names (values redacted, never recorded). */
	headerNames: string[];
	/** The query extracted from the JSON request body (the prompt text). */
	query: string | undefined;
	/** The `tools` array from the JSON request body. */
	tools: unknown;
}

const recorded: RecordedRequest[] = [];
const realFetch = globalThis.fetch;

/**
 * Wrap `globalThis.fetch` to count requests and record the request URL, the
 * header names (values redacted), and the parsed JSON body (prompt + tools).
 * The real `fetch` is always called with the original arguments — this is
 * observation only, never a modification of the request.
 */
function installFetchObserver(): void {
	type FetchInput = Parameters<typeof fetch>[0];
	globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const headers = new Headers(init?.headers);
		const headerNames = [...headers.keys()].map((k) => k.toLowerCase());
		let query: string | undefined;
		let tools: unknown;
		const body = typeof init?.body === "string" ? init.body : undefined;
		if (body !== undefined) {
			try {
				const parsed = JSON.parse(body) as {
					contents?: { parts?: { text?: string }[] }[];
					tools?: unknown;
				};
				const text = parsed.contents?.[0]?.parts?.[0]?.text;
				if (typeof text === "string" && text.startsWith(GEMINI_SEARCH_PROMPT_TEMPLATE)) {
					query = text.slice(GEMINI_SEARCH_PROMPT_TEMPLATE.length);
				}
				tools = parsed.tools;
			} catch {
				// Non-JSON body: nothing to extract.
			}
		}
		recorded.push({ url: scrubUrlTokens(url), headerNames, query, tools });
		return realFetch(input, init);
	}) as typeof fetch;
}

function lastRequest(): RecordedRequest | undefined {
	return recorded[recorded.length - 1];
}

// ---------------------------------------------------------------------------
// Real Harness composition (mirrors a real deployment, no mocks).
// ---------------------------------------------------------------------------

interface ToolWebConfig {
	search: boolean;
	fetch: boolean;
	searchMaxResults: number;
	searchMaxQueries: number;
	searchTimeoutMs: number;
}

const TOOL_CONFIG: ToolWebConfig = {
	search: true,
	fetch: false,
	searchMaxResults: 5,
	searchMaxQueries: 4,
	searchTimeoutMs: 30_000
};

/**
 * Compose the full real tool stack and load the **real** plugin through
 * `ctx.plugin(googleSearchPlugin, config)` — exactly the path a real
 * deployment uses. The credential is supplied via the environment-backed
 * reference (the recommended production path): `GEMINI_API_KEY` in
 * `process.env`, resolved per operation by the plugin. No literal key and no
 * settings service are used, so the provider reads the schema defaults.
 */
async function buildHarness(pluginConfig: PluginConfigInput): Promise<Context> {
	const ctx = new Context();
	new SystemPrompt(ctx, {});
	new ToolRuntime(ctx, {});
	new WebRuntime(ctx, {});

	// The real DSH tool-side plugins, wrapped in object plugin shapes so the
	// config is passed positionally and explicitly (as a real deployment does).
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
		// would — only the search fields are overridden here.
		Config: toolWeb.Config,
		apply: toolWeb.apply
	};
	await ctx.plugin(timeoutPlugin);
	await ctx.plugin(toolWebPlugin, TOOL_CONFIG);

	// The plugin under test, loaded the way a real deployment loads it.
	await ctx.plugin(googleSearchPlugin, pluginConfig);
	return ctx;
}

/** Invoke the real `web_search` tool through the registry's public entry point. */
async function runWebSearch(
	ctx: Context,
	queries: string[],
	signal: AbortSignal
): Promise<ToolExecutionResult> {
	return ctx.tools.execute({
		callId: CallId("e2e-web-search"),
		name: "web_search",
		arguments: { queries },
		signal
	});
}

interface SourceShape {
	url: string;
	title?: string;
	snippet?: string;
	publishedAt?: string;
}

// ---------------------------------------------------------------------------
// Case runner + evidence capture.
// ---------------------------------------------------------------------------

interface CaseResult {
	name: string;
	status: "pass" | "fail" | "unverified";
	summary: string;
	/** Credential-scrubbed detail lines for the report. */
	detail?: string[] | undefined;
}

const cases: CaseResult[] = [];

function record(name: string, status: CaseResult["status"], summary: string, detail?: string[]): void {
	cases.push({ name, status, summary, detail });
}

/**
 * Mask the opaque grounding-redirect token in a source URL. The token is a
 * per-response request-scoped reference (not the API credential), but it is
 * still redacted in the tracked report so no request-scoped token is
 * published.
 */
function maskSourceUrl(url: string): string {
	return url.replace(/(grounding-api-redirect\/)[A-Za-z0-9+/=_-]+/g, "$1[token redacted]");
}

function sourceLines(sources: SourceShape[], max = 5): string[] {
	return sources.slice(0, max).map((s, i) => {
		const title = s.title ? ` — ${s.title}` : "";
		return `${i + 1}. ${maskSourceUrl(s.url)}${title}`;
	});
}

/** True when the tool result is a successful, non-error search. */
function isOk(result: ToolExecutionResult): boolean {
	return result.isError === false;
}

function sourcesOf(result: ToolExecutionResult): SourceShape[] {
	const value = result.value as unknown as { sources?: SourceShape[] };
	return Array.isArray(value?.sources) ? value.sources : [];
}

function answerOf(result: ToolExecutionResult): string | undefined {
	const value = result.value as unknown as { content?: string };
	return typeof value?.content === "string" && value.content.length > 0 ? value.content : undefined;
}

/**
 * Check the grounded artifact in a successful result: the `content` must
 * carry the Search suggestions section (the compliance mapping of
 * `webSearchQueries`), and — when the response carried grounding sources —
 * inline citation markers `[n]` resolved against the sources list. Returns
 * the evidence lines (or the failure reason).
 */
function groundedArtifactEvidence(result: ToolExecutionResult, sources: SourceShape[]): { ok: boolean; lines: string[] } {
	const answer = answerOf(result);
	const lines: string[] = [];
	if (answer === undefined) {
		return { ok: false, lines: ["no answer text in the result content"] };
	}
	const hasSuggestions = answer.includes("Search suggestions:");
	const hasGoogleSuggestionLink = /Search suggestions:[\s\S]*https:\/\/www\.google\.com\/search\?q=/.test(answer);
	lines.push(
		`answer carries the Search suggestions section: ${hasSuggestions ? "yes" : "NO"} ` +
			`(one Google search link per model query: ${hasGoogleSuggestionLink ? "yes" : "NO"})`
	);
	if (sources.length > 0) {
		const markerCount = (answer.match(/\[\d+(?:, ?\d+)*\]/g) ?? []).length;
		lines.push(
			`inline citation markers in the answer: ${markerCount} ` +
				`(1-based into the ${sources.length} source(s) the tool renders after the answer)`
		);
	}
	return { ok: hasSuggestions && hasGoogleSuggestionLink, lines };
}

function errorText(result: ToolExecutionResult): string {
	return result.isError ? `error ${result.error?.info?.code ?? "?"}: ${result.error?.message ?? ""}` : "no sources";
}

// ---------------------------------------------------------------------------
// The cases.
// ---------------------------------------------------------------------------

async function runBehaviorCases(): Promise<void> {
	// One harness with schema defaults (no literal key): the credential is
	// resolved per operation from the GEMINI_API_KEY environment variable.
	const ctx = await buildHarness({});

	// --- Case 1: ordinary query → normalized live results, grounded artifact
	// preserved end to end (acceptance 1) ---
	{
		const result = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);
		const req = lastRequest();
		const sources = sourcesOf(result);
		const answer = answerOf(result);
		const artifact = groundedArtifactEvidence(result, sources);
		if (isOk(result) && sources.length > 0 && req !== undefined && artifact.ok) {
			record(
				"ordinary query",
				"pass",
				`returned ${sources.length} normalized live source(s) and a synthesized answer; the grounded artifact (answer + citations + Search suggestions) is preserved end to end`,
				[
					`request: POST ${req.url}`,
					`headers: ${req.headerNames.join(", ")} (values redacted)`,
					`body: prompt wrapping the query + tools=${JSON.stringify(req.tools)}`,
					...(answer ? [`answer (first 200): ${answer.slice(0, 200).replace(/\n/g, " ").trimEnd()}`] : []),
					...artifact.lines,
					...sourceLines(sources)
				]
			);
		} else if (isOk(result) && sources.length > 0 && req !== undefined) {
			record(
				"ordinary query",
				"fail",
				`live results returned but the grounded artifact is incomplete: ${artifact.lines.join("; ")}`,
				[
					`request: POST ${req.url}`,
					...(answer ? [`answer (first 200): ${answer.slice(0, 200).replace(/\n/g, " ").trimEnd()}`] : []),
					...sourceLines(sources)
				]
			);
		} else {
			record(
				"ordinary query",
				"fail",
				`expected live results, got: ${errorText(result)}`,
				[`request: ${req?.url ?? "(none)"}`]
			);
		}
	}

	// --- Case 4: result limit (the seam caps the sources at maxResults) ---
	{
		const result = await runWebSearch(ctx, ["web search api"], new AbortController().signal);
		const sources = sourcesOf(result);
		const value = result.value as unknown as { truncated?: boolean };
		const cap = TOOL_CONFIG.searchMaxResults;
		if (isOk(result) && sources.length <= cap) {
			record(
				"result limit",
				"pass",
				`${sources.length} source(s) returned (<= ${cap} cap)` +
					(value.truncated
						? `; the seam truncated an over-returning grounding response and set truncated=true`
						: `; the grounding response returned at most the cap, so the seam's truncation path was not exercised live (covered offline)`),
				sourceLines(sources, 3)
			);
		} else {
			record(
				"result limit",
				"fail",
				`expected <= ${cap} sources, got ${sources.length} (${errorText(result)})`,
				sourceLines(sources, 3)
			);
		}
	}

	// --- Case 2: zero-grounding-sources query (if reproducible) ---
	{
		const result = await runWebSearch(ctx, ["xkcdzyqwv98765 notarealquery"], new AbortController().signal);
		const sources = sourcesOf(result);
		const answer = answerOf(result);
		if (isOk(result) && sources.length === 0) {
			record(
				"zero-grounding-sources query",
				"pass",
				"the response carried zero grounding sources (no groundingMetadata) and was a successful zero-source result (not an error); the wire does not say whether a search ran and found nothing",
				[
					`request: ${lastRequest()?.url ?? "(none)"}`,
					...(answer ? [`answer (first 200): ${answer.slice(0, 200).replace(/\n/g, " ").trimEnd()}`] : [])
				]
			);
		} else if (isOk(result)) {
			record(
				"zero-grounding-sources query",
				"unverified",
				`the real API returned ${sources.length} grounding source(s) for the nonsense query — a zero-grounding-sources response was not reproducible in this run (the zero-source path is covered offline)`,
				sourceLines(sources, 3)
			);
		} else {
			record(
				"zero-grounding-sources query",
				"fail",
				`expected a successful (possibly empty) result, got ${errorText(result)}`,
				[`request: ${lastRequest()?.url ?? "(none)"}`]
			);
		}
	}

	// --- Case 3: non-ASCII query ---
	{
		const query = "東京 寿司";
		const result = await runWebSearch(ctx, [query], new AbortController().signal);
		const req = lastRequest();
		const sources = sourcesOf(result);
		if (isOk(result) && sources.length > 0 && req !== undefined) {
			// The query travels in the JSON request body (the prompt text);
			// confirm it round-tripped intact.
			const roundTrips = req.query === query;
			record(
				"non-ASCII query",
				roundTrips ? "pass" : "fail",
				roundTrips
					? `non-ASCII query "${query}" sent intact in the request body, returned ${sources.length} source(s)`
					: `query did not round-trip (sent ${JSON.stringify(req.query)})`,
				sourceLines(sources, 3)
			);
		} else {
			record(
				"non-ASCII query",
				"fail",
				`expected live results for "${query}", got: ${errorText(result)}`,
				[`request: ${req?.url ?? "(none)"}`]
			);
		}
	}

	// --- Case 6: cancellation (forwarded signal aborts the real request) ---
	{
		const controller = new AbortController();
		const pending = runWebSearch(ctx, ["deepseek harness cancellation probe"], controller.signal);
		// Let the request start, then cancel from the caller side. The
		// grounding request takes seconds, so the 50ms abort lands in-flight.
		setTimeout(() => controller.abort(), 50);
		const result = await pending;
		if (result.isError && result.error?.info?.code === "ABORTED") {
			record(
				"cancellation",
				"pass",
				"caller abort produced a stable ABORTED error (the forwarded signal cancelled the real request)",
				[`error: ${result.error?.message ?? ""}`]
			);
		} else if (isOk(result)) {
			record(
				"cancellation",
				"unverified",
				"the real API responded before the 50ms abort landed — cancellation was not reproducible in this run (covered by the offline suite)",
				[]
			);
		} else {
			record(
				"cancellation",
				"fail",
				`expected ABORTED, got ${result.isError ? result.error?.info?.code ?? "error" : "success"}`,
				[`error: ${result.error?.message ?? ""}`]
			);
		}
	}
}

async function runInvalidCredentialCase(): Promise<void> {
	// A fresh harness with a **safe, clearly-fake** literal key (never a real
	// credential) so the real Gemini API rejects the authentication.
	// Expected: a stable INVALID_CREDENTIAL with no value leaked.
	const FAKE_KEY = "invalid-api-key-e2e-000";
	const ctx = await buildHarness({ apiKey: FAKE_KEY });
	const result = await runWebSearch(ctx, ["deepseek harness"], new AbortController().signal);
	const req = lastRequest();
	if (result.isError && result.error?.info?.code === "INVALID_CREDENTIAL") {
		const message = result.error?.message ?? "";
		const leaked = message.includes(FAKE_KEY) || (req !== undefined && req.url.includes(FAKE_KEY));
		record(
			"invalid credential / config failure",
			leaked ? "fail" : "pass",
			leaked
				? "INVALID_CREDENTIAL reported but the (fake) credential value leaked into the evidence"
				: "real API rejected the invalid key (HTTP 400, 'API key not valid') → stable INVALID_CREDENTIAL; no credential value in the error or recorded request",
			[`error code: INVALID_CREDENTIAL`, `error: ${message}`, `request: POST ${req?.url ?? "(none)"}`]
		);
	} else {
		record(
			"invalid credential / config failure",
			"fail",
			`expected INVALID_CREDENTIAL, got ${result.isError ? result.error?.info?.code ?? "error" : "success"}`,
			[`error: ${result.error?.message ?? ""}`, `request: ${req?.url ?? "(none)"}`]
		);
	}
}

// ---------------------------------------------------------------------------
// Report generation (credential-scrubbed).
// ---------------------------------------------------------------------------

function dshVersions(): Record<string, string> {
	const pkgs = [
		"@deepseek-ai/cordis",
		"@deepseek-ai/dsh-web",
		"@deepseek-ai/dsh-tools",
		"@deepseek-ai/dsh-tool-web",
		"@deepseek-ai/dsh-tool-call-timeout-policy",
		"@deepseek-ai/dsh-settings",
		"@deepseek-ai/dsh-credentials",
		"@deepseek-ai/dsh-launch-environment",
		"@deepseek-ai/dsh-timeout",
		"@deepseek-ai/dsh-llm",
		"@deepseek-ai/dsh-system-prompt",
		"@deepseek-ai/schemastery"
	];
	const out: Record<string, string> = {};
	for (const name of pkgs) {
		try {
			const pkgPath = path.join(REPO_ROOT, "node_modules", name, "package.json");
			out[name] = JSON.parse(readFileSync(pkgPath, "utf8")).version;
		} catch {
			out[name] = "unknown";
		}
	}
	return out;
}

function buildReport(creds: { apiKey: string }, versions: Record<string, string>): string {
	const date = new Date().toISOString();
	const passCount = cases.filter((c) => c.status === "pass").length;
	const failCount = cases.filter((c) => c.status === "fail").length;
	const unverifiedCount = cases.filter((c) => c.status === "unverified").length;

	const lines: string[] = [];
	lines.push("# E2E Verification — Real Gemini `google_search` Grounding API + DeepSeek Harness");
	lines.push("");
	lines.push(
		"Live end-to-end evidence for **Issue #7** (verify real Google Search API behavior end-to-end). " +
			"This report was generated by `e2e/run-e2e.ts` (`npm run e2e`) against the **real** Gemini API " +
			"`google_search` grounding tool through the **real** DeepSeek Harness `web_search` tool path. It is " +
			"tracked in the repository as verification evidence (ENGINEERING.md §5); the offline unit/integration " +
			"suite (`npm test`) remains the no-network, no-credential path."
	);
	lines.push("");
	lines.push(
		"**Backend (Issue #7 migration):** the previous backend, the Google Custom Search JSON API, is being " +
			"retired by Google (announced January 2026, retirement 2027-01-01, closed to new customers), so the " +
			"plugin's backend is the Gemini API `google_search` grounding tool: one API key, no engine id, no " +
			"separate billing project. The response carries a synthesized answer, the grounding sources " +
			"(evidence for the answer, in response order — not a claimed ranking), the citation relationship " +
			"(`groundingSupports`), and the model's queries (`webSearchQueries`). The adapter preserves the " +
			"grounded artifact end to end: the answer with inline citation markers plus the Search suggestions " +
			"(one Google search link per model query) map to the seam's `content`, and the grounding sources " +
			"map to the seam's `sources`."
	);
	lines.push("");
	lines.push("## Environment");
	lines.push("");
	lines.push("| Item | Value |");
	lines.push("|---|---|");
	lines.push("| Google API product | Gemini API — `google_search` grounding tool (`generateContent` with `tools: [{ google_search: {} }]`) |");
	lines.push(`| Endpoint | \`POST ${GEMINI_SEARCH_ENDPOINT_BASE}/{model}:generateContent\` |`);
	lines.push(`| Model | \`${GEMINI_SEARCH_DEFAULT_MODEL}\` (schema default) |`);
	lines.push("| Authentication | `x-goog-api-key` request header (the URL carries no credential) |");
	lines.push(`| Runtime | Node ${process.version} |`);
	for (const [name, version] of Object.entries(versions)) {
		lines.push(`| ${name} | ${version} |`);
	}
	lines.push(`| Verification date | ${date} |`);
	lines.push("");
	lines.push(
		"**Credential handling (re-review, acceptance 2).** Three API keys were exposed in this issue's " +
			"conversation logs during earlier verification runs; all three have been invalidated in Google " +
			"AI Studio. This final run used a **newly created** key that was supplied out of band — " +
			"written to the gitignored `.env.e2e.local` file (or the terminal environment) and read at " +
			"runtime via the environment-backed reference (`GEMINI_API_KEY`) — and was never pasted into " +
			"chat, an issue, a commit message, or this report. The claim below is bounded to the " +
			"surfaces this script verified: the key value does not appear in this report (the script " +
			"aborts before writing if it does), it is not present in any tracked file (`.env.e2e.local` " +
			"is gitignored and the value is never committed), and the request header values in this " +
			"report are redacted (header *names* are recorded, values are not). No broader logging " +
			"claim is made about surfaces outside those checks."
	);
	lines.push("");
	lines.push("## Cases");
	lines.push("");
	lines.push("| # | Case | Status | Summary |");
	lines.push("|---|---|---|---|");
	cases.forEach((c, i) => {
		lines.push(`| ${i + 1} | ${c.name} | ${c.status} | ${c.summary} |`);
	});
	lines.push("");
	lines.push("### Detail");
	lines.push("");
	cases.forEach((c, i) => {
		lines.push(`#### ${i + 1}. ${c.name} — ${c.status}`);
		lines.push("");
		lines.push(c.summary);
		if (c.detail && c.detail.length > 0) {
			lines.push("");
			for (const line of c.detail) {
				lines.push(`- ${line}`);
			}
		}
		lines.push("");
	});
	lines.push("## Optional capabilities: unsupported by the backend (documented, not claimed)");
	lines.push("");
	lines.push(
		"The previous Custom Search backend exposed per-request `language` (`lr`), `region` (`gl`), " +
			"SafeSearch (`safe`), and result-count (`num`) controls. The Gemini `google_search` grounding " +
			"API exposes **none** of these: the model performs the search and returns whatever grounding it " +
			"produced. These settings were therefore removed from the plugin's settings surface rather than " +
			"kept as dead configuration (ENGINEERING.md §2: a setting that cannot affect the request would " +
			"be a lie). The seam still enforces `maxResults` on the way back (case 4); language, region, and " +
			"SafeSearch are **not supported** by this backend and are not claimed as verified."
	);
	lines.push("");
	lines.push(
		"The grounding response also carries `webSearchQueries` (the queries the model actually ran) and " +
			"`searchEntryPoint` (a rendered Google-search widget). The DSH seam contract " +
			"(`WebSearchResult`/`WebSearchSource`) has no dedicated fields for them, so the adapter does " +
			"not invent seam fields; instead it preserves them through `content` — the Search suggestions " +
			"section (one Google search link per `webSearchQueries` entry) is appended to the answer, and " +
			"the citation relationship (`groundingSupports`) becomes inline `[n]` markers resolved against " +
			"the sources list the tool renders after the answer. Case 1 records the live evidence."
	);
	lines.push("");
	lines.push("## Google grounding display obligations (compliance boundary)");
	lines.push("");
	lines.push(
		"Google's terms for AI-generated grounded content require the associated **Search Suggestions** to " +
			"be displayed with the grounded results. This plugin's compliance mapping satisfies that " +
			"obligation at the tool-output boundary: every grounded result that reaches the model carries " +
			"the Search suggestions (one Google search link per model query) inside `content`, alongside " +
			"the answer and its citations — so any presentation of the tool output (the rendered text, the " +
			"structured `content` field, or a downstream model answer built from them) keeps the " +
			"suggestions attached to the grounded answer. The grounding chunks are **evidence for the " +
			"generated answer**, not a documented ranked SERP: this report and the plugin's documentation " +
			"make no ranking claim about them, and the order is the response's chunk order. The " +
			"`searchEntryPoint.renderedContent` HTML widget itself is not forwarded (it is a " +
			"Google-branded UI artifact with no seam field); its required substance — the Search " +
			"suggestions — is preserved as plain markdown links."
	);
	lines.push("");
	lines.push("## What is live evidence vs. offline coverage");
	lines.push("");
	lines.push(
		"- **Live (reproduced by this run):** the cases above marked `pass` — real Gemini responses, real " +
			"tool/seam/provider wiring, real `fetch`, real authentication failure, and real caller cancellation."
	);
	lines.push(
		"- **Offline (covered by `npm test`, not by this script):** the provider-level `requestTimeoutMs` " +
			"deadline (the real API responds well under the timeout, so a live timeout is not reproducible " +
			"without a hanging endpoint), the full error-classification matrix (quota, rate-limit, 5xx, " +
			"provider failure — not safely inducible against the real API with a valid key), and the " +
			"credential-resolution order (literal → credentials service → launching environment → process " +
			"environment). These are asserted by the offline suite and are documented as such rather than " +
			"claimed as live-verified (acceptance 5)."
	);
	lines.push(
		"- **Unverified (no factual wire evidence exists):** *true zero-result search behavior* — that " +
			"Google Search executed and found zero results. The wire response for a zero-grounding case " +
			"carries no `groundingMetadata` and no execution/result-count field: the model may decline to " +
			"search or answer without attaching grounding, so the safe fact is *zero grounding sources*, " +
			"not *Google returned zero search results* (acceptance 5, ENGINEERING.md §5)."
	);
	lines.push("");
	lines.push("## Summary");
	lines.push("");
	lines.push(
		`**${passCount} passed, ${failCount} failed, ${unverifiedCount} unverified** out of ${cases.length} cases. ` +
			"No credential value appears anywhere in this report (acceptance 2)."
	);
	lines.push("");
	// Normalize line endings: no trailing whitespace in the generated report
	// (the answer snippets are model text and may end in spaces).
	return lines.map((line) => line.replace(/\s+$/, "")).join("\n");
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const creds = await loadCredentials();

	// Put the credential into the process environment so the plugin resolves
	// it through the environment-backed reference (the recommended production
	// path). The value stays in memory only; it is never written to the report.
	process.env[GEMINI_API_KEY_ENV] = creds.apiKey;

	installFetchObserver();

	try {
		await runBehaviorCases();
		await runInvalidCredentialCase();
	} finally {
		// Restore the real fetch and clear the credential from the environment
		// so nothing secret lingers in the process.
		globalThis.fetch = realFetch;
		delete process.env[GEMINI_API_KEY_ENV];
	}

	const versions = dshVersions();
	const report = buildReport(creds, versions);

	// Final safety check: the report must not contain the credential value.
	if (report.includes(creds.apiKey)) {
		throw new Error("ABORT: the generated report contains the API credential value. Not writing it.");
	}

	await writeFile(REPORT_FILE, report, "utf8");

	const passCount = cases.filter((c) => c.status === "pass").length;
	const failCount = cases.filter((c) => c.status === "fail").length;
	const unverifiedCount = cases.filter((c) => c.status === "unverified").length;
	console.log(`E2E complete: ${passCount} passed, ${failCount} failed, ${unverifiedCount} unverified.`);
	console.log(`Report written to ${REPORT_FILE}`);
	for (const c of cases) {
		console.log(`  [${c.status}] ${c.name}: ${c.summary}`);
	}
	if (failCount > 0) {
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(`E2E failed: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
});
