// Release verification: assert the committed package-lock.json root entry
// still describes the same dependency contract as package.json.
//
// A stale lock is a release blocker: `npm ci` installs from the lock, so a
// lock whose root differs from the manifest (license, dependencies, peer
// roles, version) makes the committed release inputs non-reproducible.
// This check is dependency-free (it reads the two JSON files only) and runs
// in `npm run check` and `prepublishOnly`, so a future dependency-role
// change cannot silently leave the lock stale.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const lockRoot = lock.packages[""];

const problems = [];
const check = (label, actual, expected) => {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		problems.push(`${label}: package.json=${JSON.stringify(expected)} lock=${JSON.stringify(actual)}`);
	}
};

check("name", lockRoot.name, pkg.name);
check("version", lockRoot.version, pkg.version);
check("license", lockRoot.license, pkg.license);
check("dependencies", lockRoot.dependencies ?? null, pkg.dependencies ?? null);
check("peerDependencies", lockRoot.peerDependencies ?? null, pkg.peerDependencies ?? null);
check("devDependencies", lockRoot.devDependencies ?? null, pkg.devDependencies ?? null);
if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion: ${lock.lockfileVersion} (expected 3)`);

if (problems.length > 0) {
	console.error("package-lock.json is out of sync with package.json:");
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error("Regenerate with: npm install --package-lock-only");
	process.exit(1);
}
console.log("lock consistency: package-lock.json matches package.json (name, version, license, dependencies, peerDependencies, devDependencies)");
