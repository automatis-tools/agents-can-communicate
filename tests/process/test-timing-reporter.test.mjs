import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { nodeTestArguments } from "../../scripts/test-runner-plan.mjs";
import { removeFixture } from "../helpers/fixture-cleanup.mjs";

const run = promisify(execFile);
test("timings record one completed file, rather than double-counting its nested tests", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-file-timing-")));
  t.after(() => removeFixture(root));
  const file = path.join(root, "nested.test.mjs");
  const timings = path.join(root, "timings.jsonl");
  await writeFile(file, 'import test from "node:test";\ntest(import.meta.filename, () => {});\ntest("parent", async t => { await t.test("child", () => {}); });\n');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await run(process.execPath, nodeTestArguments([file], { timings }), { env });
  assert.match(stdout, /parent/);
  const records = (await readFile(timings, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(records.length, 1, "timing output missed the file or repeated its child durations");
  assert.equal(records[0].file, file);
  assert.equal(records[0].success, true);
  assert.ok(Number.isFinite(records[0].durationMs) && records[0].durationMs > 0);
});
