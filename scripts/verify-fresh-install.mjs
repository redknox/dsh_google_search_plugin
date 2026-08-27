// Fresh-home install verification for the DSH bundle (Issue #8 evidence,
// ENGINEERING.md §5). Boots a throwaway DSH_HOME, installs the packed
// tarball through the real `dsh plugin` path, and asserts the shipped
// behavior end to end:
//
//   1. install          — `dsh plugin --profile <name> add <tarball>` succeeds
//   2. active on install— a zero-config boot resolves `searchProvider: google`
//                         (the bundle layer overrides the dsh-base default)
//   3. installed copy   — the plugin module resolves to the profile's own
//                         node_modules, never the source checkout
//   4. live search      — (only when GEMINI_API_KEY is set) the real
//                         web_search tool returns content + sources
//   5. escape hatch     — a profile-layer `web` override wins over the bundle
//   6. removal          — removing the plugin reverts the default route
//
// Usage:
//   node scripts/verify-fresh-install.mjs [tarball] [query]
//
// Requirements: Node >= 24; pnpm (>= 10) on PATH; a `dsh` CLI on PATH or
// DSH_BIN pointing at it. The scratch home lives in the system temporary
// directory (never inside this repository — see the note at its creation)
// and is deleted on success. No credential is ever printed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tarball = resolve(process.argv[2] ?? findTarball());
const query = process.argv[3] ?? "What is the capital of Australia?";
const profileName = "verify";

function findTarball() {
	const pkg = readJson(join(repoRoot, "package.json"));
	const name = `redknox-dsh-google-search-plugin-${pkg.version}.tgz`;
	if (!existsSync(join(repoRoot, name))) {
		console.error(`no tarball found; packing ${name} first…`);
		const packed = spawnSync("npm", ["pack", "--pack-destination", "."], {
			cwd: repoRoot,
			stdio: "inherit"
		});
		if (packed.status !== 0) process.exit(packed.status ?? 1);
	}
	return name;
}
function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

// --- locate the dsh CLI and its framework packages -------------------------
const dshBin = process.env.DSH_BIN ?? "dsh";
const which = spawnSync(process.platform === "win32" ? "where" : "which", [dshBin], { encoding: "utf8" });
const dshPath = which.status === 0 ? which.stdout.trim().split("\n")[0] : null;
if (!dshPath) {
	console.error(`dsh CLI not found (tried ${dshBin}); put it on PATH or set DSH_BIN`);
	process.exit(1);
}
// The CLI lives in <root>/node_modules/.bin/dsh; the framework packages sit
// beside it in <root>/node_modules/@deepseek-ai.
const npxRoot = dirname(dirname(dshPath));
const installAnchor = join(npxRoot, "@deepseek-ai", "dsh", "package.json");
if (!existsSync(installAnchor)) {
	console.error(`cannot locate @deepseek-ai/dsh next to the CLI (looked in ${npxRoot})`);
	process.exit(1);
}
// The boot path is not on dsh-app-boot's exports map; import the file
// directly (the same composition the CLI boot path applies).
const { boot, healProfilesModuleFallback, loadOptionalPatches, loadProfile } = await import(
	pathToFileURL(join(npxRoot, "@deepseek-ai", "dsh-app-boot", "lib", "index.js")).href
);

// --- scratch home -----------------------------------------------------------
// The home must NOT live inside this repository: Node's upward module
// resolution from the profile directory would hit the repo's own
// node_modules (dev dependencies only) and shadow the framework fallback.
//
// It must also be COMPLETELY EMPTY: the boot process (this Node process)
// resolves DSH_HOME from its own process environment — the env object below
// only reaches the spawned `dsh` CLI, not the in-process boot. Any existing
// file in the scratch dir (e.g. a malformed .credentials.yaml copied by a
// failed run) would be picked up by the in-process boot and abort the
// verification.
const scratch = join(tmpdir(), `dsh-gsp-verify-${Date.now()}`);
mkdirSync(scratch, { recursive: true });
// DSH_HOME must reach BOTH the spawned `dsh` CLI (profile management) and
// this Node process (the in-process boot resolves DSH_HOME from its own
// process environment). Setting it on process.env covers both.
process.env.DSH_HOME = scratch;
const env = { ...process.env, GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "" };

const results = [];
function step(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function dsh(args) {
	// The CLI is spawned with env.DSH_HOME = scratch, so it manages the
	// profile inside the scratch home, not the user's real ~/.dsh.
	const r = spawnSync(dshPath, args, { env, cwd: repoRoot, encoding: "utf8" });
	return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

try {
	// 1. install through the real CLI path (auto-inits the profile)
	const add = dsh(["plugin", "--profile", profileName, "add", tarball]);
	step("install via dsh plugin add", add.status === 0, add.status === 0 ? "profile auto-initialized with dsh-base" : add.out.slice(-400));
	if (add.status !== 0) throw new Error("install failed");

	// boot helper: the same composition the CLI boot path applies
	healProfilesModuleFallback(installAnchor, scratch);
	async function bootProfile() {
		const profile = loadProfile("dsh", profileName, installAnchor, scratch, { userLayer: true });
		writeFileSync(join(profile.dir, "cordis.yml"), "# dsh profile root\n[]\n");
		const homePatches = loadOptionalPatches("dsh", join(scratch, "cordis.patch.yml")) ?? [];
		const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
		const allPatches = [...bundlePatches, ...profile.patches, ...homePatches];
		return boot("dsh", join(profile.dir, "cordis.yml"), structuredClone(allPatches), undefined);
	}
	async function inspect() {
		const ctx = await bootProfile();
		const web = ctx.get("web");
		const require2 = createRequire(join(profileDir(), "package.json"));
		let resolved = null;
		try {
			resolved = require2.resolve("dsh-google-search-plugin");
		} catch {
			/* removed */
		}
		const out = {
			provider: web.searchProviderId,
			registered: [...web.searchProviders.keys()],
			resolved
		};
		await ctx.fiber.dispose();
		return out;
	}
	function profileDir() {
		return join(scratch, "profiles", profileName);
	}

	// 2 + 3. zero-config boot: active on install, installed copy
	let state = await inspect();
	step("active on install (zero config)", state.provider === "google", `searchProvider=${state.provider}`);
	step("google provider registered", state.registered.includes("google"), `providers=[${state.registered.join(", ")}]`);
	step(
		"plugin resolves to installed copy",
		!!state.resolved && state.resolved.includes(join("profiles", profileName, "node_modules")) && !state.resolved.includes(join(repoRoot, "lib")),
		state.resolved ?? "not resolvable"
	);

	// 4. live search (only with a real key; never printed)
	if (env.GEMINI_API_KEY) {
		const ctx = await bootProfile();
		const tool = ctx.get("tools").layers.global.tools.get("web_search");
		const started = Date.now();
		const result = await tool.execute({ queries: [query] }, { signal: AbortSignal.timeout(90_000) });
		const ms = Date.now() - started;
		step(
			"live web_search returns grounded content",
			typeof result.content === "string" && result.content.length > 0 && Array.isArray(result.sources) && result.sources.length > 0,
			`${ms} ms, ${result.sources.length} source(s), content ${result.content.length} chars`
		);
		await ctx.fiber.dispose();
	} else {
		step("live web_search", true, "SKIPPED (no GEMINI_API_KEY in environment)");
	}

	// 5. escape hatch: profile layer wins over the bundle layer
	writeFileSync(
		join(profileDir(), "cordis.patch.yml"),
		"# profile-layer override (escape hatch)\n- id: web\n  config:\n    searchProvider: deepseek-official\n"
	);
	state = await inspect();
	step(
		"profile-layer override wins (escape hatch)",
		state.provider === "deepseek-official" && state.registered.includes("google"),
		`searchProvider=${state.provider}, google still registered=${state.registered.includes("google")}`
	);

	// 6. removal reverts the default route
	const remove = dsh(["plugin", "--profile", profileName, "remove", "dsh-google-search-plugin"]);
	step("remove via dsh plugin remove", remove.status === 0, remove.status === 0 ? "bundle row + dependency dropped" : remove.out.slice(-400));
	if (remove.status === 0) {
		state = await inspect();
		step(
			"default route reverts after removal",
			state.provider === "deepseek-official" && !state.registered.includes("google") && state.resolved === null,
			`searchProvider=${state.provider}, providers=[${state.registered.join(", ")}]`
		);
	} else {
		step("default route reverts after removal", false, "skipped (removal failed)");
	}
} catch (error) {
	console.error(`verification aborted: ${error?.message ?? error}`);
	process.exitCode = 1;
} finally {
	if (process.exitCode) {
		console.error(`scratch home kept for inspection: ${scratch}`);
	} else {
		rmSync(scratch, { recursive: true, force: true });
	}
	const failed = results.filter((r) => !r.ok);
	console.log(failed.length === 0 ? `fresh-install verification: all ${results.length} steps passed` : `fresh-install verification: ${failed.length} step(s) FAILED`);
	process.exitCode = process.exitCode ?? (failed.length === 0 ? 0 : 1);
}
