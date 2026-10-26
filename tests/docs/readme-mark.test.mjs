import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..", "..");

// npm renders the same README, so the mark is an absolute URL, and it is the website's
// own file: one source for the mark instead of a copy that can drift from it.
test("the README opens with the mark the website serves", async () => {
  const readme = await readFile(path.join(repo, "README.md"), "utf8");
  const [opening] = readme.split("\n# ");
  assert.match(opening, /<img src="https:\/\/getacc\.dev\/assets\/acc-mark\.svg" alt="ACC logo: two linked rings" width="\d+"/);
  assert.match(readme, /\n# Agents Can Communicate \(ACC\)\n/);
});
