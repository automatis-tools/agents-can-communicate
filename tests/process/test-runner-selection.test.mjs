import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const runner = path.join(repo, "scripts/run-tests.mjs");
const list = async args => (await run(process.execPath, [runner, "--list", ...args], { cwd: repo }))
  .stdout.split(/\r?\n/).filter(line => line.endsWith(".test.mjs"));

test("every discovered file runs exactly once across shards, including newly added files", async () => {
  const all = await list([]);
  for (const count of [2, 3]) {
    const shards = await Promise.all(Array.from({ length: count }, (_, index) => list(["--shard", `${index + 1}/${count}`])));
    assert.deepEqual(shards.flat().sort(), all, "a shard dropped or repeated a file");
    assert.equal(new Set(shards.flat()).size, all.length);
    assert.ok(Math.max(...shards.map(files => files.length)) - Math.min(...shards.map(files => files.length)) <= 1);
  }
});

test("invalid, repeated, unknown and empty shard selections fail before packing", async () => {
  for (const args of [["--shard", "0/2"], ["--shard", "3/2"], ["--shard", "1/0"],
    ["--shard", "1.5/2"], ["--shard"], ["--shard", "9999/9999"],
    ["--shard", "1/2", "--shard", "2/2"], ["--typo"], ["--shard", "1/2", "--if-needed"]]) {
    const result = await run(process.execPath, [runner, "--list", ...args], { cwd: repo })
      .then(value => ({ ...value, code: 0 }), error => error);
    assert.notEqual(result.code, 0, `accepted ${JSON.stringify(args)}`);
    assert.match(result.stderr, /shard|argument|empty|if-needed/);
  }
});


test("selection plans require one non-flag file and cannot combine with shards", async () => {
  for (const args of [["--selection-plan"], ["--selection-plan", ""], ["--selection-plan", "--list"],
    ["--selection-plan", "a", "--selection-plan", "b"], ["--selection-plan", "a", "--shard", "1/1"]]) {
    await assert.rejects(run(process.execPath, [runner, "--list", ...args], { cwd: repo }), /selection-plan|argument/);
  }
});
