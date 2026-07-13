import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableVersion(value, label) {
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`${label} must be a stable semantic version, got ${JSON.stringify(value)}`);
  }

  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error(`${label} contains a component larger than Number.MAX_SAFE_INTEGER`);
  }
  return parts;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

export function nextPatchVersion(packageVersion, tags) {
  const stableTags = tags
    .filter((tag) => STABLE_VERSION_PATTERN.test(tag))
    .map((tag) => parseStableVersion(tag, "release tag"));
  const baseline = stableTags.length === 0
    ? parseStableVersion(packageVersion, "package.json version")
    : stableTags.reduce((highest, candidate) => compareVersions(candidate, highest) > 0 ? candidate : highest);
  const [major, minor, patch] = baseline;

  if (patch === Number.MAX_SAFE_INTEGER) {
    throw new Error("Cannot increment patch version beyond Number.MAX_SAFE_INTEGER");
  }
  return `${major}.${minor}.${patch + 1}`;
}

const isEntrypoint = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tags = execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  process.stdout.write(`${nextPatchVersion(packageJson.version, tags)}\n`);
}
