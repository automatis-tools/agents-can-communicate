import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { claimSpellingProject as project } from "../helpers/claim-spelling-project.mjs";

/** Whether this filesystem treats two spellings as one file. Asked, not assumed. */
async function caseInsensitive(root) {
  return stat(path.join(root, "src", "PHYSICS.mjs")).then(() => true, () => false);
}

for (const spelling of ["file:./src/physics.mjs", "file:src//physics.mjs",
  "file:src/x/../physics.mjs"]) {
  test(`a claim written as ${spelling} still covers the file`, async t => {
    const place = await project(t);
    await place.claim(spelling);

    assert.equal(await place.write("src/physics.mjs"), "deny",
      "the claim was taken and protected nothing");
  });
}

test("the claim is stored under the one name, whatever it was typed as", async t => {
  const place = await project(t);

  const { stdout } = await place.claim("file:./src//physics.mjs");

  // What is echoed back is what a peer will see in `acc status`, so a claim that
  // reads differently from the file everyone else names is a claim nobody can
  // reason about.
  assert.match(stdout, /^claimed file:src\/physics\.mjs$/m);
});

test("case follows the filesystem, because that is what decides it", async t => {
  const place = await project(t);
  const merged = await caseInsensitive(place.root);
  await place.claim("file:src/Physics.mjs");

  const decision = await place.write("src/physics.mjs");

  // Where the two spellings are one file, a claim on either has to cover both.
  // Where they are two files, they are two resources and must stay so. No case
  // rule appears anywhere in ACC: `realpath` answers it on each machine.
  assert.equal(decision, merged ? "deny" : "allow",
    merged
      ? "one file on this filesystem, and the claim covered only one spelling"
      : "two files on this filesystem, and a claim on one blocked the other");
});

test("a glob keeps its meaning through normalisation", async t => {
  const place = await project(t);
  await place.claim("file:./src/**");

  assert.equal(await place.write("src/physics.mjs"), "deny");
  assert.equal(await place.write("README.md"), "allow");
});

for (const [spelling, expected] of [
  ["file:src", /is a directory; claim file:src\/\*\* to cover/],
  ["file:src/", /is a directory; claim file:src\/\*\* to cover/],
  ["file:src/*.mjs", /matches nothing: only a trailing \/\*\* is understood/],
  ["file:src/*", /matches nothing: only a trailing \/\*\* is understood/],
]) {
  test(`${spelling} is refused rather than stored as protection`, async t => {
    const place = await project(t, { owner: "cli" });

    // Each of these was accepted, stored, and reported as `protection guarded`
    // while covering nothing at all. The claim was useless either way; refusing
    // is how its author finds out.
    const failure = await place.claim(spelling).then(() => null, error => error);

    assert.notEqual(failure, null, `${spelling} was stored and protects nothing`);
    assert.equal(failure.code, 2, `claim must reject with CLI usage error: ${failure.message}`);
    assert.equal(typeof failure.stderr, "string", `claim did not return CLI diagnostics: ${failure.message}`);
    assert.match(failure.stderr, expected);
  });
}

test("a path that does not exist yet can still be claimed", async t => {
  const place = await project(t);

  // Claiming before creating is the point of a claim, so an absent path is not
  // evidence of a mistake the way a directory is.
  const { stdout } = await place.claim("file:src/renderer.mjs");

  assert.match(stdout, /claimed file:src\/renderer\.mjs/);
});

test("a resource that is not a file is left exactly as it is", async t => {
  const place = await project(t);

  // Other schemes are opaque identifiers. Rewriting one would be inventing
  // meaning ACC does not have.
  const { stdout } = await place.claim("url:https://example.test/./a//b");

  assert.match(stdout, /claimed url:https:\/\/example\.test\/\.\/a\/\/b/);
});
