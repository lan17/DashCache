import assert from "node:assert/strict";
import test from "node:test";

import { nextPatchVersion } from "./release-version.mjs";

test("increments the package seed when there are no release tags", () => {
  assert.equal(nextPatchVersion("0.1.0", []), "0.1.1");
});

test("increments the highest stable release tag", () => {
  assert.equal(nextPatchVersion("0.1.0", ["v0.1.2", "v0.1.10", "v0.2.0"]), "0.2.1");
});

test("ignores unrelated and prerelease tags", () => {
  assert.equal(nextPatchVersion("1.2.3", ["latest", "v2.0.0-rc.1"]), "1.2.4");
});

test("rejects an invalid package seed", () => {
  assert.throws(
    () => nextPatchVersion("01.2.3", []),
    /package\.json version must be a stable semantic version/,
  );
});

test("rejects an overflowing patch component", () => {
  assert.throws(
    () => nextPatchVersion(`1.2.${Number.MAX_SAFE_INTEGER}`, []),
    /Cannot increment patch version/,
  );
});
