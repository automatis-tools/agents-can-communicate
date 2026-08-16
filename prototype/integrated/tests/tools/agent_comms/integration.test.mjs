import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createGitWorktreeFixture, hermeticEnv, runCli, startCli } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function jsonCli(fixture, argv, options) {
  const result = await runCli(fixture, [...argv, "--json"], options);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("the executable covers every command and stable process exit", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const executable = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    "../../../tools/agents/comms.mjs");
  const [firstLine, details] = await Promise.all([
    readFile(executable, "utf8").then(text => text.split("\n")[0]), stat(executable),
  ]);
  assert.equal(firstLine, "#!/usr/bin/env node");
  assert.notEqual(details.mode & 0o111, 0);

  const beforeInit = await runCli(fixture, ["status"], { cwd: fixture.worktree });
  assert.equal(beforeInit.code, 4);
  assert.match(beforeInit.stderr, /protocol/i);
  assert.equal((await runCli(fixture, ["unknown"])).code, 2);
  assert.equal((await runCli(fixture, ["wait", "--id", "visual", "--timeout"])).code, 2);

  const initialized = await jsonCli(fixture, ["init"], { cwd: fixture.worktree });
  assert.equal(initialized.schema_version, 1);
  await jsonCli(fixture, ["register", "--id", "visual", "--role", "orchestrator", "--task",
    "M2.7", "--ownership", "game/presentation"], { cwd: fixture.worktree });
  await jsonCli(fixture, ["register", "--id", "models", "--role", "artist", "--task", "M2.7"],
    { cwd: fixture.worktree });

  const sent = await jsonCli(fixture, ["send", "--from", "visual", "--to", "models", "--type",
    "question", "--severity", "action", "--subject", "first", "--body", "inline",
    "--requires-ack"], { cwd: fixture.worktree });
  const bodyFile = path.join(fixture.worktree, "body.txt");
  await writeFile(bodyFile, "from file");
  await jsonCli(fixture, ["send", "--from", "visual", "--to", "models", "--type", "status",
    "--severity", "info", "--subject", "second", "--body-file", "body.txt"],
  { cwd: fixture.worktree });
  await jsonCli(fixture, ["send", "--from", "visual", "--to", "models", "--type", "status",
    "--severity", "info", "--subject", "third"], { cwd: fixture.worktree, input: "stdin" });
  await writeFile(path.join(fixture.bus, "presence", "models.json"), `${JSON.stringify({
    schema_version: 1, agent_id: "models", pid: process.pid, status: "online",
    heartbeat_at: new Date().toISOString(),
  })}\n`);
  const broadcast = await jsonCli(fixture, ["broadcast", "--from", "visual", "--severity", "info",
    "--subject", "notice", "--body", "all"], { cwd: fixture.worktree });
  assert.equal(broadcast.length, 1);

  const inbox = await jsonCli(fixture, ["inbox", "--id", "models"], { cwd: fixture.worktree });
  assert.equal(inbox.length, 4);
  await jsonCli(fixture, ["ack", "--id", "models", "--message", sent.id], { cwd: fixture.worktree });
  await jsonCli(fixture, ["reply", "--from", "models", "--message", sent.id, "--type",
    "contract_response", "--severity", "info", "--subject", "answer", "--body", "done"],
  { cwd: fixture.worktree });
  await jsonCli(fixture, ["inbox", "--id", "visual"], { cwd: fixture.worktree });

  const timeout = await runCli(fixture, ["wait", "--id", "visual", "--timeout", "0.01"],
    { cwd: fixture.worktree });
  assert.equal(timeout.code, 3, timeout.stderr);
  assert.equal(timeout.stderr, "");

  const watch = startCli(fixture, ["watch", "--id", "models", "--scan-interval", "0.01"],
    { cwd: fixture.worktree });
  watch.stdin.end();
  await delay(80);
  await jsonCli(fixture, ["send", "--from", "visual", "--to", "models", "--type", "status",
    "--severity", "info", "--subject", "watch", "--body", "event"], { cwd: fixture.worktree });
  await delay(120);
  watch.kill("SIGINT");
  const watchCode = await new Promise(resolve => watch.once("close", resolve));
  assert.equal(watchCode, 0);
  assert.ok(watch.collected.stdout.trim().split("\n").every(line => JSON.parse(line).event === "message"));

  await jsonCli(fixture, ["claim", "--id", "models", "--scope", "game/models", "--reason", "mesh"],
    { cwd: fixture.worktree });
  assert.equal((await runCli(fixture, ["claim", "--id", "visual", "--scope", "game/models",
    "--reason", "overlap"], { cwd: fixture.worktree })).code, 5);
  await jsonCli(fixture, ["release", "--id", "models", "--scope", "game/models"],
    { cwd: fixture.worktree });

  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"],
    { cwd: fixture.worktree, env: hermeticEnv() })).stdout.trim();
  await writeFile(path.join(fixture.worktree, "proof.txt"), "proof");
  await writeFile(path.join(fixture.worktree, "verification.json"), JSON.stringify([
    { command: "node --test", exitCode: 0, summary: "passed" },
  ]));
  await writeFile(path.join(fixture.worktree, "contracts.json"), JSON.stringify({
    added: [], changed: [], consumed: [],
  }));
  await writeFile(path.join(fixture.worktree, "limitations.json"), "[]");
  await jsonCli(fixture, ["handoff", "--id", "models", "--to", "visual", "--task", "M2.7",
    "--result", "ready", "--branch", "linked", "--commit", revision, "--base", revision,
    "--changed", "proof.txt", "--artifact", "proof.txt", "--verification-file", "verification.json",
    "--contracts-file", "contracts.json", "--limitations-file", "limitations.json"],
  { cwd: fixture.worktree });

  const status = await jsonCli(fixture, ["status"], { cwd: fixture.worktree });
  assert.equal(status.protocol.schema_version, 1);
  const required = await runCli(fixture, ["doctor", "--require-live", "visual"],
    { cwd: fixture.worktree });
  assert.equal(required.code, 6);
  await jsonCli(fixture, ["close", "--id", "models"], { cwd: fixture.worktree });

  await writeFile(path.join(fixture.bus, "inbox", "visual", "broken.json"), "{");
  const corrupt = await runCli(fixture, ["inbox", "--id", "visual"], { cwd: fixture.worktree });
  assert.equal(corrupt.code, 4);
  assert.equal((await runCli(fixture, ["doctor"], { cwd: fixture.worktree })).code, 4);
  assert.equal((await runCli(fixture, ["doctor", "--repair"], { cwd: fixture.worktree })).code, 0);
});
