import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..", "..");

test("the release workflow creates its pack destination before npm writes there", async () => {
  const workflow = await readFile(path.join(repo, ".github", "workflows", "release.yml"),
    "utf8");
  const prepare = workflow.indexOf("run: mkdir -p dist");
  const pack = workflow.indexOf("run: npm pack --pack-destination dist");

  assert.notEqual(prepare, -1, "release.yml never creates dist/");
  assert.ok(prepare < pack, "release.yml creates dist/ only after npm needs it");
});
