// Combined regressions 1-5 and 12 from docs/MIGRATION.md. These exercise the
// reconciled tree end to end: the lifecycle guard from 0002 standing on the
// managed-root storage from 0003, reached through real CLI processes so that
// workspace identity, stdout purity, and exit codes are all observed together.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { closeAgent, registerAgent } from "../../../tools/agents/lib/identity.mjs";
import { acquireWatcherOwnership } from "../../../tools/agents/lib/watcher-ownership.mjs";
import { createBusFixture, createGitWorktreeFixture, runCli, startCli } from "./helpers.mjs";

const MESSAGE_ID = "00000000-0000-4000-8000-000000000001";
const SHA = "a".repeat(40);
const GATE_TIMEOUT_MS = 30_000;

// Every command the CLI accepts apart from init and prompt, each with the
// minimum valid argv so that argument parsing succeeds and the protocol gate,
// not the parser, is what decides the outcome.
const GATED_COMMANDS = [
  ["register", "--id", "visual", "--role", "artist", "--task", "M2.7"],
  ["close", "--id", "visual"],
  ["send", "--from", "visual", "--to", "models", "--type", "status", "--severity", "info",
    "--subject", "s", "--body", "b"],
  ["broadcast", "--from", "visual", "--severity", "info", "--subject", "s", "--body", "b"],
  ["inbox", "--id", "visual"],
  ["ack", "--id", "visual", "--message", MESSAGE_ID],
  ["reply", "--from", "visual", "--message", MESSAGE_ID, "--type", "status",
    "--severity", "info", "--subject", "s", "--body", "b"],
  ["watch", "--id", "visual"],
  ["wait", "--id", "visual", "--timeout", "0"],
  ["claim", "--id", "visual", "--scope", "game/models", "--reason", "r"],
  ["release", "--id", "visual", "--scope", "game/models"],
  ["handoff", "--id", "visual", "--to", "models", "--task", "M2.7", "--result", "done",
    "--branch", "topic", "--base", SHA, "--commit", SHA, "--verification-file", "v.json",
    "--contracts-file", "c.json", "--limitations-file", "l.json"],
  ["status"],
  ["doctor"],
  ["doctor", "--repair"],
];

async function snapshotTree(root, relative = "") {
  const entries = (await readdir(path.join(root, relative), { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const snapshot = [];
  for (const entry of entries) {
    const item = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      snapshot.push(["directory", item], ...await snapshotTree(root, item));
    } else {
      snapshot.push(["file", item, (await readFile(path.join(root, item))).toString("base64")]);
    }
  }
  return snapshot;
}

// watch is the only gated command with no --json option, so machine mode is
// requested per command rather than assumed.
const supportsJson = argv => argv[0] !== "watch";

// watch never terminates on its own, so a blocked gate must not hang the suite.
async function runGated(fixture, argv, cwd) {
  const child = startCli(fixture, supportsJson(argv) ? [...argv, "--json"] : argv, { cwd });
  child.stdin.end();
  const exited = new Promise(resolve => child.once("close", code => resolve({
    code, stdout: child.collected.stdout, stderr: child.collected.stderr })));
  let ceiling;
  const expired = new Promise(resolve => { ceiling = setTimeout(resolve, GATE_TIMEOUT_MS, null); });
  const result = await Promise.race([exited, expired]);
  clearTimeout(ceiling);
  if (result !== null) return result;
  child.kill("SIGKILL");
  await exited;
  return assert.fail(`${argv[0]} never exited: the protocol gate did not block it`);
}

async function foreignFixture(t) {
  const owner = await createGitWorktreeFixture();
  const foreign = await createGitWorktreeFixture();
  t.after(async () => { await Promise.all([owner.cleanup(), foreign.cleanup()]); });
  const initialized = await runCli(owner, ["init", "--json"], { cwd: owner.worktree });
  assert.equal(initialized.code, 0, initialized.stderr);
  return { owner, foreign };
}

async function writeProtocol(fixture, mutate) {
  const file = path.join(fixture.owner.bus, "protocol.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, `${JSON.stringify(mutate(record))}\n`);
}

test("1: a foreign workspace protocol blocks every non-init command before mutation", async t => {
  const fixture = await foreignFixture(t);
  const before = await snapshotTree(fixture.owner.bus);

  for (const argv of GATED_COMMANDS) {
    const result = await runGated(fixture.owner, argv, fixture.foreign.worktree);
    assert.equal(result.code, EXIT.DATA, `${argv.join(" ")}: ${result.stderr || result.stdout}`);
    if (supportsJson(argv)) {
      assert.equal(result.stderr, "", `${argv[0]} polluted stderr in JSON mode`);
      assert.equal(JSON.parse(result.stdout).error.exit_code, EXIT.DATA);
    } else {
      assert.equal(result.stdout, "", `${argv[0]} wrote a human error to stdout`);
      assert.notEqual(result.stderr, "", `${argv[0]} reported nothing on stderr`);
    }
    assert.deepEqual(await snapshotTree(fixture.owner.bus), before,
      `${argv.join(" ")} mutated a foreign workspace`);
  }
});

test("2: a malformed foreign protocol blocks ordinary commands and doctor --repair", async t => {
  const fixture = await foreignFixture(t);
  await writeFile(path.join(fixture.owner.bus, "protocol.json"), "{not-json");
  const before = await snapshotTree(fixture.owner.bus);

  for (const argv of [["close", "--id", "visual"], ["doctor", "--repair"]]) {
    const result = await runGated(fixture.owner, argv, fixture.foreign.worktree);
    assert.equal(result.code, EXIT.DATA, result.stderr || result.stdout);
    assert.deepEqual(await snapshotTree(fixture.owner.bus), before,
      `${argv.join(" ")} mutated a foreign workspace with an unreadable protocol`);
  }
});

test("12: an unknown protocol version fails closed before any repair", async t => {
  const fixture = await foreignFixture(t);
  await writeProtocol(fixture, record => ({ ...record, protocol_version: 99 }));
  const before = await snapshotTree(fixture.owner.bus);

  for (const argv of [["close", "--id", "visual"], ["doctor", "--repair"], ["status"]]) {
    const result = await runGated(fixture.owner, argv, fixture.foreign.worktree);
    assert.equal(result.code, EXIT.DATA, result.stderr || result.stdout);
    assert.deepEqual(await snapshotTree(fixture.owner.bus), before,
      `${argv.join(" ")} mutated a workspace with an unknown protocol version`);
  }
});

test("12: an unknown schema version fails closed on the owning checkout too", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  assert.equal((await runCli(fixture, ["init"], { cwd: fixture.worktree })).code, 0);
  const file = path.join(fixture.bus, "protocol.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, `${JSON.stringify({ ...record, schema_version: 99 })}\n`);
  const before = await readFile(file);

  const repaired = await runGated(fixture, ["doctor", "--repair"], fixture.worktree);

  assert.equal(repaired.code, EXIT.DATA, repaired.stderr || repaired.stdout);
  assert.deepEqual(await readFile(file), before, "repair rewrote an unknown schema version");
});

test("3: init validates an existing protocol identity before changing layout", async t => {
  const fixture = await foreignFixture(t);
  await rm(path.join(fixture.owner.bus, "artifacts"), { recursive: true });
  const before = await snapshotTree(fixture.owner.bus);

  const result = await runGated(fixture.owner, ["init"], fixture.foreign.worktree);

  assert.equal(result.code, EXIT.DATA, result.stderr || result.stdout);
  assert.deepEqual(await snapshotTree(fixture.owner.bus), before,
    "init created layout inside a foreign workspace");
});

test("4: register, close, and watcher start share one ownership critical section", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = { ...fixture.context, pid: 4242, pidIsAlive: () => true,
    gitState: async () => ({ branch: "topic", head: SHA }),
    releaseOwnedClaims: async () => [] };
  const registration = { agentId: "visual", role: "artist", task: "M2.7",
    worktree: "/tmp/worktree-a", ownership: [] };
  await registerAgent(context, registration);
  await acquireWatcherOwnership(context, "visual", 4242);

  // One watcher owner excludes every other lifecycle transition for that agent.
  await assert.rejects(registerAgent(context, { ...registration, resume: true }),
    error => error.exitCode === EXIT.CONFLICT);
  await assert.rejects(closeAgent(context, "visual"),
    error => error.exitCode === EXIT.CONFLICT);
  await assert.rejects(acquireWatcherOwnership(context, "visual", 4243),
    error => error.exitCode === EXIT.CONFLICT);
});

test("5: broadcast reaches live sessions, not merely registered-open ones", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const run = argv => runCli(fixture, [...argv, "--json"], { cwd: fixture.worktree });
  assert.equal((await run(["init"])).code, 0);
  for (const id of ["visual", "models"]) {
    assert.equal((await run(["register", "--id", id, "--role", "artist", "--task", "M2.7"])).code, 0);
  }
  const base = ["broadcast", "--from", "visual", "--severity", "info", "--subject", "s",
    "--body", "b"];

  const registeredOnly = await run(base);

  assert.equal(registeredOnly.code, 0, registeredOnly.stderr);
  assert.deepEqual(JSON.parse(registeredOnly.stdout), [],
    "broadcast published to an agent that is open but not live");

  await mkdir(path.join(fixture.bus, "presence"), { recursive: true });
  await writeFile(path.join(fixture.bus, "presence", "models.json"), `${JSON.stringify({
    schema_version: 1, agent_id: "models", pid: process.pid, status: "online",
    heartbeat_at: new Date().toISOString() })}\n`);

  const live = await run(base);

  assert.equal(live.code, 0, live.stderr);
  assert.deepEqual(JSON.parse(live.stdout).map(item => item.to), ["models"]);
});
