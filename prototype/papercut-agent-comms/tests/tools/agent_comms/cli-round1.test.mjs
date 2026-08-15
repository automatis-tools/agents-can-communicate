import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { runWithSignals } from "../../../tools/agents/comms.mjs";
import { readJsonStrict } from "../../../tools/agents/lib/atomic-json.mjs";
import { validatePresence } from "../../../tools/agents/lib/schema.mjs";
import { createGitWorktreeFixture, runCli, startCli } from "./helpers.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function bootstrap(fixture) {
  for (const argv of [["init"], ["register", "--id", "visual", "--role", "orchestrator", "--task", "M2.7"],
    ["register", "--id", "models", "--role", "artist", "--task", "M2.7"]]) {
    const result = await runCli(fixture, argv, { cwd: fixture.worktree });
    assert.equal(result.code, 0, result.stderr);
  }
}

async function openStdinResult(child) {
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const result = await Promise.race([exited, delay(300).then(() => null)]);
  if (result !== null) return result;
  child.kill("SIGKILL");
  await exited;
  assert.fail("command waited for stdin despite an explicit body source");
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
    const result = await openStdinResult(startCli(fixture, argv, { cwd: fixture.worktree }));
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
  const presence = await readJsonStrict(`${fixture.bus}/presence/visual.json`, validatePresence);
  assert.equal(presence.status, "offline");
});

test("SIGTERM is accepted by the executable watcher lifecycle", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  await bootstrap(fixture);
  const watch = startCli(fixture, ["watch", "--id", "models", "--scan-interval", "0.01"],
    { cwd: fixture.worktree });
  watch.stdin.end();
  await delay(80);
  watch.kill("SIGTERM");
  const code = await new Promise(resolve => watch.once("close", resolve));
  assert.equal(code, 0);
  assert.equal(watch.collected.stdout, "");
});
