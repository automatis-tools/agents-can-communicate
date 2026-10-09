import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("Codex POSIX permission fixtures stay skipped when Windows has no getuid", async () => {
  const target = new URL("../../packages/adapter-codex/test/native-permission-errors.test.mjs", import.meta.url);
  const source = `Object.defineProperty(process, "platform", { value: "win32" });
    process.getuid = undefined;
    await import(${JSON.stringify(target.href)});`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await run(process.execPath, ["--test-reporter=tap", "--input-type=module", "--eval", source], { env })
    .catch(error => ({ stdout: error.stdout, stderr: error.stderr }));
  const counts = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)]
    .map(([, name, count]) => [name, Number(count)]));
  assert.ok(counts.tests > 0, result.stdout || result.stderr);
  assert.equal(counts.pass, 0, result.stdout);
  assert.equal(counts.fail, 0, result.stdout);
  assert.equal(counts.skipped, counts.tests, result.stdout);
});
