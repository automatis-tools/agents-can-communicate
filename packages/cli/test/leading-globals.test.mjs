import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.mjs";

test("global options select the same command before and after its name", () => {
  for (const globals of [["--cwd", "/a project"], ["--workspace=/a/config.json"], ["--json"]]) {
    assert.deepEqual(parseArgs([...globals, "status"]), parseArgs(["status", ...globals]));
  }
  assert.deepEqual(parseArgs(["--cwd", "/project", "--json", "config", "validate"]),
    parseArgs(["config", "validate", "--cwd", "/project", "--json"]));
  assert.deepEqual(parseArgs(["--cwd", "/project", "help", "inbox"]),
    parseArgs(["help", "inbox", "--cwd", "/project"]));
});

test("global values cannot be mistaken for commands or help aliases", () => {
  assert.equal(parseArgs(["--cwd", "status", "inbox"]).command, "inbox");
  assert.equal(parseArgs(["--cwd=--help", "status"]).options.cwd, "--help");
  assert.equal(parseArgs(["--json", "message", "--subject", "test", "--body=--cwd"])
    .options.body, "--cwd");
});

test("leading globals preserve missing-value and duplicate-option errors", () => {
  for (const args of [["--cwd"], ["--cwd", "--json", "status"], ["--cwd=", "status"],
    ["--json=true", "status"], ["--cwd", "/a", "status", "--cwd", "/b"],
    ["--json", "status", "--json"], ["--participant", "someone", "status"]]) {
    assert.throws(() => parseArgs(args), error => error.code === 2);
  }
});
