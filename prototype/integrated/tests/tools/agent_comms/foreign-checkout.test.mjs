import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createGitWorktreeFixture, pathExists, runCli } from "./helpers.mjs";

async function succeeds(fixture, argv) {
  const result = await runCli(fixture, [...argv, "--json"], { cwd: fixture.worktree });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function foreignBusFixture(t, agents) {
  const owner = await createGitWorktreeFixture();
  const foreign = await createGitWorktreeFixture();
  t.after(async () => { await Promise.all([owner.cleanup(), foreign.cleanup()]); });
  await succeeds(owner, ["init"]);
  for (const agent of agents) await succeeds(owner,
    ["register", "--id", agent, "--role", "artist", "--task", "M2.7"]);
  return { owner, foreign };
}

async function snapshotTree(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const snapshot = [];
  for (const entry of entries) {
    const item = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      snapshot.push(["directory", item]);
      snapshot.push(...await snapshotTree(root, item));
    } else {
      snapshot.push(["file", item,
        (await readFile(path.join(root, item))).toString("base64")]);
    }
  }
  return snapshot;
}

async function foreignCommand(fixture, argv, message = /different checkout/) {
  const before = await snapshotTree(fixture.owner.bus);
  const result = await runCli(fixture.owner, [...argv, "--json"], {
    cwd: fixture.foreign.worktree,
  });
  const after = await snapshotTree(fixture.owner.bus);
  assert.deepEqual(after, before, `${argv[0]} mutated a foreign checkout bus`);
  assert.equal(result.code, 4, result.stderr || result.stdout);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.exit_code, 4);
  assert.match(error.message, message);
}

test("close cannot mutate a matching-version bus owned by another checkout", async t => {
  const fixture = await foreignBusFixture(t, ["visual"]);
  await foreignCommand(fixture, ["close", "--id", "visual"]);
});

test("send cannot mutate a matching-version bus owned by another checkout", async t => {
  const fixture = await foreignBusFixture(t, ["visual", "models"]);
  await foreignCommand(fixture, ["send", "--from", "visual", "--to", "models", "--type",
    "status", "--severity", "info", "--subject", "foreign", "--body", "must not publish"]);
});

test("doctor repair cannot mutate a matching-version foreign bus", async t => {
  const fixture = await foreignBusFixture(t, []);
  const corrupt = path.join(fixture.owner.bus, "inbox", "foreign", "broken.json");
  await mkdir(path.dirname(corrupt));
  await writeFile(corrupt, "{not-json");
  await foreignCommand(fixture, ["doctor", "--repair"]);
});

test("doctor repair cannot mutate a foreign bus whose protocol is corrupt", async t => {
  const fixture = await foreignBusFixture(t, []);
  await writeFile(path.join(fixture.owner.bus, "protocol.json"), "{not-json");

  await foreignCommand(fixture, ["doctor", "--repair"], /cannot prove checkout identity/);
});

test("init validates a foreign protocol before creating missing layout directories", async t => {
  const fixture = await foreignBusFixture(t, []);
  await rm(path.join(fixture.owner.bus, "artifacts"), { recursive: true });
  await rm(path.join(fixture.owner.bus, "archive"), { recursive: true });

  await foreignCommand(fixture, ["init"]);
});

// A foreign bus whose protocol cannot even be parsed or whose version is
// unknown must fail closed for ordinary commands too, not only for repair:
// an unreadable identity is never permission to mutate someone else's bus.
async function unknownVersionProtocol(fixture) {
  const file = path.join(fixture.owner.bus, "protocol.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, `${JSON.stringify({ ...record, protocol_version: 99 })}\n`);
}

test("normal commands cannot mutate a foreign bus whose protocol is malformed", async t => {
  const fixture = await foreignBusFixture(t, ["visual"]);
  await writeFile(path.join(fixture.owner.bus, "protocol.json"), "{not-json");

  await foreignCommand(fixture, ["close", "--id", "visual"], /invalid JSON record/);
});

test("normal commands cannot mutate a foreign bus whose protocol version is unknown", async t => {
  const fixture = await foreignBusFixture(t, ["visual"]);
  await unknownVersionProtocol(fixture);

  await foreignCommand(fixture, ["close", "--id", "visual"], /unknown protocol version/);
});

test("doctor repair cannot mutate a foreign bus whose protocol version is unknown", async t => {
  const fixture = await foreignBusFixture(t, []);
  await unknownVersionProtocol(fixture);

  await foreignCommand(fixture, ["doctor", "--repair"], /cannot prove checkout identity/);
});

test("init refuses a foreign protocol standing alone without any layout directory", async t => {
  const fixture = await foreignBusFixture(t, []);
  const protocolFile = path.join(fixture.owner.bus, "protocol.json");
  const record = await readFile(protocolFile);
  for (const entry of await readdir(fixture.owner.bus)) {
    if (entry !== "protocol.json") await rm(path.join(fixture.owner.bus, entry), { recursive: true });
  }

  await foreignCommand(fixture, ["init"]);

  assert.deepEqual(await readdir(fixture.owner.bus), ["protocol.json"]);
  assert.deepEqual(await readFile(protocolFile), record);
});

test("doctor repair may quarantine a corrupt protocol on the canonical checkout bus", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  await succeeds(fixture, ["init"]);
  await writeFile(path.join(fixture.bus, "protocol.json"), "{not-json");

  const result = await runCli(fixture, ["doctor", "--repair", "--json"], {
    cwd: fixture.worktree,
  });

  assert.equal(result.code, 4, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.repairs.some(item => item.action === "quarantine_corrupt_json"), true);
  assert.equal(await pathExists(path.join(fixture.bus, "protocol.json")), false);
});

test("a valid external bus bound to the current checkout remains usable", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const externalBus = path.join(fixture.root, "external-bus");
  const options = { cwd: fixture.worktree, env: { PW2_AGENT_BUS_DIR: externalBus } };
  const initialized = await runCli(fixture, ["init", "--json"], options);
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);

  const doctor = await runCli(fixture, ["doctor", "--json"], options);

  assert.equal(doctor.code, 0, doctor.stderr || doctor.stdout);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
});
