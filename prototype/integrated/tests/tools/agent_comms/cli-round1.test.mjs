import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { runWithSignals } from "../../../tools/agents/comms.mjs";
import { readJsonStrict } from "../../../tools/agents/lib/atomic-json.mjs";
import { validatePresence } from "../../../tools/agents/lib/schema.mjs";
import { createGitWorktreeFixture, pathExists, runCli, startCli } from "./helpers.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const WATCHER_READY_TIMEOUT_MS = 10_000;
const WATCHER_POLL_MS = 5;
const STDIN_LIVENESS_TIMEOUT_MS = 30_000;

function describeChild(child, prefix) {
  return `${prefix}; stdout=${JSON.stringify(child.collected.stdout)}`
    + `; stderr=${JSON.stringify(child.collected.stderr)}`;
}

// The watcher installs its signal handlers before it publishes ownership, so an
// online presence record owned by this exact child proves the handler is armed.
// A fixed startup sleep does not: the child dies from the default SIGTERM
// disposition whenever the machine is slower than the guessed delay.
async function waitForWatcherOnline(fixture, child, agentId) {
  const ownership = `${fixture.bus}/locks/watcher-${agentId}.json`;
  const presence = `${fixture.bus}/presence/${agentId}.json`;
  let exit = null;
  child.once("close", (code, signal) => { exit = { code, signal }; });
  const deadline = Date.now() + WATCHER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exit !== null) {
      assert.fail(describeChild(child, `watcher exited before publishing ownership: ${JSON.stringify(exit)}`));
    }
    if (await pathExists(ownership)) {
      const record = await readJsonStrict(presence, validatePresence, fixture.bus)
        .catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (record?.status === "online" && record.pid === child.pid) return record;
    }
    await delay(WATCHER_POLL_MS);
  }
  assert.fail(describeChild(child, `watcher did not come online within ${WATCHER_READY_TIMEOUT_MS}ms`));
}

async function bootstrap(fixture) {
  for (const argv of [["init"], ["register", "--id", "visual", "--role", "orchestrator", "--task", "M2.7"],
    ["register", "--id", "models", "--role", "artist", "--task", "M2.7"]]) {
    const result = await runCli(fixture, argv, { cwd: fixture.worktree });
    assert.equal(result.code, 0, result.stderr);
  }
}

// The property under test is liveness -- the command must not read stdin -- not
// latency. A command that truly waits on an unclosed stdin blocks forever, so a
// generous ceiling still catches it, while a short race deadline only converts
// ordinary scheduling delay under parallel load into a false failure.
async function openStdinResult(child, argv) {
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // Promise.race does not cancel the loser: an uncleared ceiling timer would
  // keep the runner alive for its full duration after the child already exited.
  let ceiling;
  const expired = new Promise(resolve => {
    ceiling = setTimeout(resolve, STDIN_LIVENESS_TIMEOUT_MS, null);
  });
  const result = await Promise.race([exited, expired]);
  clearTimeout(ceiling);
  if (result !== null) return result;
  child.kill("SIGKILL");
  await exited;
  assert.fail(describeChild(child, `${argv[0]} waited for stdin for `
    + `${STDIN_LIVENESS_TIMEOUT_MS}ms despite an explicit body source`));
}

test("explicit body sources let send broadcast and reply exit with stdin left open", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  await bootstrap(fixture);
  await writeFile(`${fixture.worktree}/body.txt`, "from file");
  const original = await runCli(fixture, ["send", "--from", "visual", "--to", "models", "--type",
    "question", "--severity", "info", "--subject", "original", "--body", "source", "--json"],
  { cwd: fixture.worktree });
  const message = JSON.parse(original.stdout);
  const base = ["--from", "visual", "--to", "models", "--type", "status", "--severity", "info",
    "--subject", "open-stdin"];
  const commands = [
    ["send", ...base, "--body", "inline"], ["send", ...base, "--body-file", "body.txt"],
    ["broadcast", "--from", "visual", "--severity", "info", "--subject", "broadcast", "--body", "inline"],
    ["broadcast", "--from", "visual", "--severity", "info", "--subject", "broadcast", "--body-file", "body.txt"],
    ["reply", "--from", "models", "--message", message.id, "--type", "status", "--severity", "info",
      "--subject", "reply", "--body", "inline"],
    ["reply", "--from", "models", "--message", message.id, "--type", "status", "--severity", "info",
      "--subject", "reply", "--body-file", "body.txt"],
  ];
  for (const argv of commands) {
    const result = await openStdinResult(startCli(fixture, argv, { cwd: fixture.worktree }), argv);
    assert.equal(result.code, 0, `${argv[0]} did not exit cleanly`);
  }
});

test("successful human output is human text rather than JSON", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const result = await runCli(fixture, ["init"], { cwd: fixture.worktree });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "agent bus initialized\n");
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("{"), false);
});

test("force-stale release requires an orchestrator and releases the named stale owner", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  await bootstrap(fixture);
  const claimed = await runCli(fixture, ["claim", "--id", "models", "--scope", "game/models",
    "--reason", "mesh"], { cwd: fixture.worktree });
  assert.equal(claimed.code, 0, claimed.stderr);
  const claimFile = `${fixture.bus}/claims/${(await readdir(`${fixture.bus}/claims`))[0]}`;
  const stale = JSON.parse(await readFile(claimFile, "utf8"));
  stale.expires_at = "2020-01-01T00:00:00.000Z";
  await writeFile(claimFile, `${JSON.stringify(stale)}\n`);
  const denied = await runCli(fixture, ["release", "--id", "models", "--scope", "game/models",
    "--force-stale", "--owner", "models"], { cwd: fixture.worktree });
  assert.equal(denied.code, 5);
  const released = await runCli(fixture, ["release", "--id", "visual", "--scope", "game/models",
    "--force-stale", "--owner", "models"], { cwd: fixture.worktree });
  assert.equal(released.code, 0, released.stderr);
  assert.equal(released.stdout, "released game/models\n");
});

test("a latched startup signal stops the watcher after publication", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const signals = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const runtime = { cwd: fixture.worktree, env: { PW2_AGENT_BUS_DIR: fixture.bus }, stdin: Readable.from([]), stdout,
    stderr, pid: 1234, pidIsAlive: () => true,
    watchDirectory: () => ({ close() {}, once() {} }),
    beforeWatcherPublish: async () => { signals.emit("SIGTERM"); } };
  assert.equal(await runWithSignals(["init"], runtime, signals), 0);
  assert.equal(await runWithSignals(["register", "--id", "visual", "--role", "artist", "--task", "M2.7"],
    runtime, signals), 0);
  assert.equal(await runWithSignals(["watch", "--id", "visual"], runtime, signals), 0);
  const presence = await readJsonStrict(`${fixture.bus}/presence/visual.json`, validatePresence,
    fixture.bus);
  assert.equal(presence.status, "offline");
});

test("SIGTERM is accepted by the executable watcher lifecycle", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  await bootstrap(fixture);
  const watch = startCli(fixture, ["watch", "--id", "models", "--scan-interval", "0.01"],
    { cwd: fixture.worktree });
  watch.stdin.end();
  await waitForWatcherOnline(fixture, watch, "models");
  watch.kill("SIGTERM");
  const outcome = await new Promise(resolve =>
    watch.once("close", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(outcome, { code: 0, signal: null },
    describeChild(watch, `watcher did not stop gracefully: ${JSON.stringify(outcome)}`));
  assert.equal(watch.collected.stdout, "");
});
