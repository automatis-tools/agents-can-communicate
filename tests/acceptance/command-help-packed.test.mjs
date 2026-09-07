import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);
const owner = session => ["--session", session.sessionId, "--generation", session.generation];

test("installed command help answers without credentials, discovery, or writes", async t => {
  const packed = await createPackedAcc(t);
  const blocked = path.join(packed.root, "not-a-directory");
  await writeFile(blocked, "blocked");
  const env = { ...packed.env, ACC_DATA_HOME: blocked };
  const invoke = argv => run(process.execPath, [packed.accBin, ...argv,
    "--cwd", path.join(blocked, "missing")], { cwd: packed.project, env });
  await assert.rejects(invoke(["status"]));
  const general = JSON.parse((await invoke(["help", "--json"])).stdout).data;
  for (const { name } of general.commands.flatMap(group => group.commands)) {
    const result = await invoke([name, "--help", "--json"]);
    assert.equal(result.stderr, "");
    const data = JSON.parse(result.stdout).data;
    if (name !== "help") assert.equal(data.name, name);
  }
  for (const argv of [["help", "attach"], ["attach", "-h"],
    ["config", "--help"], ["help", "config", "init"],
    ["config", "init", "--yes", "--force", "--help"],
    ["install", "--help", "--adapter", "codex"]]) {
    const result = await invoke(argv);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Usage: acc (attach|config|install)/);
  }
  assert.deepEqual(await readdir(packed.project), []);
  assert.deepEqual(await readdir(packed.clientHome), []);
});

test("installed help supplies usable attach, work, and finish arguments", async t => {
  const packed = await createPackedAcc(t);
  const attachHelp = await packed.acc(["help", "attach"]);
  assert.ok(attachHelp.required.includes("participant"));
  assert.ok(attachHelp.optional.includes("harness"));
  const worker = await packed.acc(["attach", "--participant", "worker", "--harness", "cli"]);
  const peer = await packed.acc(["attach", "--participant", "peer"]);
  const workHelp = await packed.acc(["work", "--help"]);
  assert.ok(workHelp.choices.mode.includes("review"), "help cannot express reviewing work");
  assert.ok(workHelp.repeated.includes("hint"));
  assert.ok(workHelp.flags.includes("clear"));
  for (const mode of workHelp.choices.mode) {
    const result = await packed.acc(["work", ...owner(worker), "--summary", "Inspecting CLI",
      "--mode", mode]);
    assert.equal(result.mode, mode, "an advertised mode cannot be used");
  }
  const finishHelp = await packed.acc(["finish", "--help"]);
  assert.ok(finishHelp.choices.status.includes("complete"));
  const human = await run(process.execPath, [packed.accBin, "finish", "--help"],
    { cwd: packed.project, env: packed.env });
  assert.match(human.stdout, /--status[^\n]*complete/);
  const finished = await packed.acc(["finish", ...owner(worker), "--goal", "CLI inspected",
    "--status", "complete"]);
  assert.equal(finished.message.handoff.status, "complete");
  await packed.acc(["detach", ...owner(peer)]);
});

test("help-looking message values are delivered unchanged and typos stay errors", async t => {
  const packed = await createPackedAcc(t);
  const sender = await packed.acc(["attach", "--participant", "sender"]);
  const reader = await packed.acc(["attach", "--participant", "reader"]);
  for (const body of ["--help", "-h", "--help=anything"]) {
    const sent = await packed.acc(["message", ...owner(sender), "--to", "reader",
      "--subject", "Literal console output", "--body", body]);
    const [received] = await packed.acc(["inbox", ...owner(reader),
      "--message", sent.message.messageId]);
    assert.equal(received.message.body, body);
  }
  for (const args of [["help", "teleport"], ["help", "constructor"],
    ["toString", "--help"], ["help", "__proto__"], ["help", "config", "delete"],
    ["attach"], ["reply", ...owner(sender), "--message", "message_example"],
    ["work", "--help", "--typo"], ["attach", "--help=true"]]) {
    const error = await packed.accError(args);
    assert.equal(error?.code, 2, `${args.join(" ")} must remain a usage error`);
    if (args[0] === "reply") {
      assert.match(JSON.parse(error.stdout).error.message, /requires --body/);
    }
    if (args[0] === "toString") {
      assert.equal(JSON.parse(error.stdout).error.details.command, "toString");
    }
  }
});
