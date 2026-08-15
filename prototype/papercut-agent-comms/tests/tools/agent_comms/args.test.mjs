import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../../tools/agents/lib/args.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";

test("register preserves repeated ownership scopes", () => {
  const parsed = parseArgs(["register", "--id", "visual", "--role", "artist", "--task",
    "M2.7", "--ownership", "game/presentation", "--ownership", "contract:paint-v1"]);
  assert.deepEqual(parsed, { command: "register", options: { id: "visual", role: "artist",
    task: "M2.7", ownership: ["game/presentation", "contract:paint-v1"] } });
});

test("message body sources are exclusive", () => {
  assert.throws(() => parseArgs(["send", "--from", "visual", "--to", "models", "--type",
    "status", "--severity", "info", "--subject", "update", "--body", "one", "--body-file",
    "two.txt"]), error => error.exitCode === EXIT.USAGE);
});

test("handoff accepts its fixed repeated and structured grammar", () => {
  const parsed = parseArgs(["handoff", "--id", "visual", "--to", "orchestrator", "--task",
    "M2.7", "--result", "ready", "--branch", "feature/visual", "--commit", "a".repeat(40),
    "--base", "b".repeat(40), "--changed", "game/view.gd", "--follow-up", "models",
    "--artifact", "build/proof.txt", "--verification-file", "verify.json", "--contracts-file",
    "contracts.json", "--limitations-file", "limits.json"]);
  assert.deepEqual(parsed.options.changed, ["game/view.gd"]);
  assert.deepEqual(parsed.options.followUp, ["models"]);
  assert.deepEqual(parsed.options.artifact, ["build/proof.txt"]);
});

test("unknown options, values and commands are usage errors", () => {
  for (const argv of [["status", "--mystery"], ["register", "--id"], ["invent"]]) {
    assert.throws(() => parseArgs(argv), error => error.exitCode === EXIT.USAGE);
  }
});

test("force stale release requires an explicit owner", () => {
  assert.throws(() => parseArgs(["release", "--id", "visual", "--scope", "game/view",
    "--force-stale"]), error => error.exitCode === EXIT.USAGE);
});

test("prompt requires every ownership scope to contain non-whitespace content", () => {
  for (const argv of [
    ["prompt", "--id", "visual", "--role", "visual", "--task", "M2.7"],
    ["prompt", "--id", "visual", "--role", "visual", "--task", "M2.7", "--ownership", ""],
    ["prompt", "--id", "visual", "--role", "visual", "--task", "M2.7", "--ownership", "",
      "--ownership", "game/presentation"],
    ["prompt", "--id", "visual", "--role", "visual", "--task", "M2.7", "--ownership",
      "game/presentation", "--ownership", ""],
    ["prompt", "--id", "visual", "--role", "visual", "--task", "M2.7", "--ownership", " \t "],
  ]) assert.throws(() => parseArgs(argv), error => error.exitCode === EXIT.USAGE);
});
