import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createGitWorktreeFixture, pathExists, runCli } from "./helpers.mjs";

async function succeeds(fixture, argv) {
  const result = await runCli(fixture, [...argv, "--json"], { cwd: fixture.worktree });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

async function bootstrap(fixture, agents = []) {
  await succeeds(fixture, ["init"]);
  for (const agent of agents) await succeeds(fixture,
    ["register", "--id", agent, "--role", "artist", "--task", "M2.7"]);
}

function protocolError(result, exitCode) {
  assert.equal(result.code, exitCode);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed), ["error"]);
  assert.deepEqual(Object.keys(parsed.error).sort(), ["details", "exit_code", "message"]);
  assert.equal(parsed.error.exit_code, exitCode);
  assert.equal(typeof parsed.error.message, "string");
  return parsed;
}

test("normal commands validate protocol before mutating bus state", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  await bootstrap(fixture, ["visual"]);
  const registryPath = path.join(fixture.bus, "registry", "visual.json");
  const before = await readFile(registryPath, "utf8");
  await writeFile(path.join(fixture.bus, "protocol.json"), "{not-json");

  const result = await runCli(fixture, ["close", "--id", "visual", "--json"],
    { cwd: fixture.worktree });
  protocolError(result, 4);
  assert.equal(await readFile(registryPath, "utf8"), before);
  assert.equal(await pathExists(path.join(fixture.bus, "presence", "visual.json")), false);
});

test("init identity comes from Git even when the bus has an explicit override", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const externalBus = path.join(fixture.root, "external-bus");
  const result = await runCli(fixture, ["init", "--json"], { cwd: fixture.worktree,
    env: { PW2_AGENT_BUS_DIR: externalBus } });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const protocol = JSON.parse(result.stdout);
  const commonDir = await realpath(path.join(fixture.main, ".git"));
  assert.equal(protocol.checkout_root, fixture.main);
  assert.equal(protocol.checkout_id, createHash("sha256").update(commonDir).digest("hex"));
});

test("doctor maps unknown schema and protocol versions to data exit four", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const original = await succeeds(fixture, ["init"]);
  for (const [field, value, issueCode] of [
    ["schema_version", 2, "UNKNOWN_SCHEMA_VERSION"],
    ["protocol_version", 2, "UNKNOWN_PROTOCOL_VERSION"],
  ]) {
    await writeFile(path.join(fixture.bus, "protocol.json"),
      `${JSON.stringify({ ...original, [field]: value })}\n`);
    const result = await runCli(fixture, ["doctor", "--json"], { cwd: fixture.worktree });
    assert.equal(result.code, 4);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.issues.some(issue => issue.code === issueCode), true);
  }
});

test("json usage and conflict errors are one stable machine value", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  protocolError(await runCli(fixture, ["invent", "--json"]), 2);
  const human = await runCli(fixture, ["invent"]);
  assert.equal(human.code, 2);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /unknown command/);

  await bootstrap(fixture, ["visual"]);
  const duplicate = await runCli(fixture, ["register", "--id", "visual", "--role", "artist",
    "--task", "M2.7", "--json"], { cwd: fixture.worktree });
  protocolError(duplicate, 5);
  assert.equal(duplicate.stdout.trim().split("\n").length, 1);
});

test("json wait timeout is one stable machine value", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  await bootstrap(fixture, ["visual"]);
  const result = await runCli(fixture, ["wait", "--id", "visual", "--timeout", "0.01",
    "--json"], { cwd: fixture.worktree });
  protocolError(result, 3);
  assert.equal(JSON.parse(result.stdout).error.message, "wait timed out");
});

test("broadcast snapshots only open agents with fresh live presence", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  await bootstrap(fixture, ["sender", "active", "heartbeatless", "stale", "offline", "dead"]);
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 46_000).toISOString();
  const presence = (agentId, pid, status, heartbeatAt) => ({ schema_version: 1,
    agent_id: agentId, pid, status, heartbeat_at: heartbeatAt });
  for (const record of [
    presence("active", process.pid, "online", fresh),
    presence("stale", process.pid, "online", old),
    presence("offline", process.pid, "offline", fresh),
    presence("dead", 99_999_999, "online", fresh),
  ]) await writeFile(path.join(fixture.bus, "presence", `${record.agent_id}.json`),
    `${JSON.stringify(record)}\n`);

  const delivered = await succeeds(fixture, ["broadcast", "--from", "sender", "--severity",
    "info", "--subject", "live only", "--body", "snapshot"]);
  assert.deepEqual(delivered.map(message => message.to), ["active"]);
});

test("handoff accepts committed and ephemeral artifacts through distinct routes", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  await bootstrap(fixture, ["visual", "orchestrator"]);
  const revision = "a".repeat(40);
  await writeFile(path.join(fixture.worktree, "proof.txt"), "committed proof");
  await writeFile(path.join(fixture.bus, "artifacts", "capture.txt"), "ephemeral proof");
  await writeFile(path.join(fixture.worktree, "verification.json"), JSON.stringify([
    { command: "node --test", exitCode: 0, summary: "passed" },
  ]));
  await writeFile(path.join(fixture.worktree, "contracts.json"), JSON.stringify({
    added: [], changed: [], consumed: [],
  }));
  await writeFile(path.join(fixture.worktree, "limitations.json"), "[]");

  const value = await succeeds(fixture, ["handoff", "--id", "visual", "--to", "orchestrator",
    "--task", "M2.7", "--result", "ready", "--branch", "feature/visual", "--commit", revision,
    "--base", revision, "--changed", "proof.txt", "--artifact", "proof.txt",
    "--ephemeral-artifact", ".agents/artifacts/capture.txt", "--verification-file",
    "verification.json", "--contracts-file", "contracts.json", "--limitations-file",
    "limitations.json"]);
  assert.deepEqual(value.record.artifacts.map(artifact => ({ path: artifact.path,
    ephemeral: artifact.ephemeral, commit: artifact.commit ?? null })), [
    { path: "proof.txt", ephemeral: false, commit: revision },
    { path: ".agents/artifacts/capture.txt", ephemeral: true, commit: null },
  ]);
  assert.equal((await readdir(path.join(fixture.bus, "handoffs"))).length, 1);
});
