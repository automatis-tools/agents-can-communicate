import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";

import { openFilesystemStore } from "../../packages/storage-filesystem/src/store.mjs";
import { readOpenJournals } from "../../packages/storage-filesystem/src/journal.mjs";
import { createFakeClock, createFakeIds } from "../helpers/memory-store.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const storeModule = new URL("../../packages/storage-filesystem/src/store.mjs", import.meta.url).href;

const NOW = "2026-08-16T01:00:00.000Z";
const WORKSPACE = "workspace_a";
const CONTENDERS = 5;

const workspaceRecord = displayName => ({ schemaVersion: SCHEMA_VERSION,
  workspaceId: WORKSPACE, displayName, source: "directory", roots: ["/tmp/example"],
  createdAt: NOW });

// Independent processes, not concurrent promises: the writer mutex, the
// journal, and the no-replace publication only mean anything across real
// process boundaries.
const child = (root, barrier, label, generation) => `
import { openFilesystemStore } from ${JSON.stringify(storeModule)};
import { access } from "node:fs/promises";

const clock = { now: () => ${JSON.stringify(NOW)} };
let counter = 0;
const ids = { next: kind => \`\${kind}_\${${JSON.stringify(label)}}_\${counter += 1}\` };
const store = await openFilesystemStore({ root: ${JSON.stringify(root)}, clock, ids,
  workspaceId: ${JSON.stringify(WORKSPACE)} });

for (let attempt = 0; attempt < 2000; attempt += 1) {
  try { await access(${JSON.stringify(barrier)}); break; } catch {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

try {
  await store.transaction(async tx => {
    tx.put("workspace", ${JSON.stringify(WORKSPACE)}, ${JSON.stringify(workspaceRecord(label))},
      ${JSON.stringify(generation)});
    tx.append({ schemaVersion: ${SCHEMA_VERSION}, eventId: \`event_${label}\`,
      workspaceId: ${JSON.stringify(WORKSPACE)}, actorSessionId: "session_a",
      type: "session.opened", occurredAt: ${JSON.stringify(NOW)}, payload: {} });
  });
  process.stdout.write("won");
  process.exit(0);
} catch (error) {
  process.stdout.write(String(error.code ?? "unknown"));
  process.exit(typeof error.code === "number" ? error.code : 1);
}
`;

test("independent processes cannot both win the same optimistic write", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-concurrency-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const barrier = path.join(root, "start");

  const store = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE });
  await store.transaction(async tx => {
    tx.put("workspace", WORKSPACE, workspaceRecord("seed"));
    tx.append({ schemaVersion: SCHEMA_VERSION, eventId: "event_seed",
      workspaceId: WORKSPACE, actorSessionId: "session_a", type: "workspace.materialised",
      occurredAt: NOW, payload: {} });
  });
  const generation = await store.transaction(async tx => tx.generationOf("workspace", WORKSPACE));

  const runs = Array.from({ length: CONTENDERS }, (_, index) =>
    execFileAsync(process.execPath,
      ["--input-type=module", "--eval", child(root, barrier, `c${index}`, generation)],
      { cwd: repoRoot })
      .then(({ stdout }) => ({ code: 0, stdout }))
      .catch(error => ({ code: error.code, stdout: error.stdout ?? "" })));

  await writeFile(barrier, "go");
  const results = await Promise.all(runs);

  const winners = results.filter(result => result.code === 0);
  const losers = results.filter(result => result.code !== 0);

  assert.equal(winners.length, 1, `expected exactly one winner, saw ${winners.length}`);
  assert.equal(losers.length, CONTENDERS - 1);
  for (const loser of losers) {
    assert.equal(loser.code, EXIT.CONFLICT,
      `a losing process exited ${loser.code} rather than EXIT.CONFLICT`);
  }
});

test("the event log has no gaps and no duplicate sequences after contention", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-concurrency-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const barrier = path.join(root, "start");

  const store = await openFilesystemStore({ root, clock: createFakeClock(NOW),
    ids: createFakeIds(), workspaceId: WORKSPACE });
  await store.transaction(async tx => {
    tx.put("workspace", WORKSPACE, workspaceRecord("seed"));
    tx.append({ schemaVersion: SCHEMA_VERSION, eventId: "event_seed",
      workspaceId: WORKSPACE, actorSessionId: "session_a", type: "workspace.materialised",
      occurredAt: NOW, payload: {} });
  });
  const generation = await store.transaction(async tx => tx.generationOf("workspace", WORKSPACE));

  const runs = Array.from({ length: CONTENDERS }, (_, index) =>
    execFileAsync(process.execPath,
      ["--input-type=module", "--eval", child(root, barrier, `d${index}`, generation)],
      { cwd: repoRoot }).catch(() => undefined));
  await writeFile(barrier, "go");
  await Promise.all(runs);

  const files = (await readdir(path.join(root, "events"))).sort();
  const sequences = files.map(file => Number(path.basename(file, ".json")));

  assert.deepEqual(sequences, [1, 2], "the event log gained a gap or a duplicate");
  assert.equal(new Set(sequences).size, sequences.length);
  assert.deepEqual(await readOpenJournals(store.paths, root), [],
    "a completed journal entry was still treated as open");

  // A losing process must leave nothing behind at all, not even an event.
  const events = await Promise.all(files.map(async file =>
    JSON.parse(await readFile(path.join(root, "events", file), "utf8"))));
  assert.deepEqual(events.map(event => event.type),
    ["workspace.materialised", "session.opened"]);
  await access(path.join(root, "protocol.json"));
});

/** A workspace nobody has opened, and the CLI, for the first-run race. */
async function freshWorkspace(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-fresh-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-fresh-data-")));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const env = { ...process.env, ACC_DATA_HOME: dataHome, GIT_DIR: "", GIT_WORK_TREE: "" };
  const attach = participant => execFileAsync(process.execPath,
    [path.join(repoRoot, "bin", "acc.mjs"), "attach", "--participant", participant,
      "--harness", "cli", "--cwd", cwd, "--json"], { env });
  return { cwd, dataHome, env, attach };
}

test("agents starting together in a fresh workspace all get in", async t => {
  const place = await freshWorkspace(t);

  // The first thing every process does is establish the store's identity, and
  // that document carries the moment it was written. Two of them racing wrote
  // records differing in exactly that field, so the loser was refused for
  // "record already published with different bytes" and could not attach at all
  // - in a workspace neither had opened before, which is the ordinary way two
  // agents start.
  const outcomes = await Promise.all(["alpha", "beta", "gamma", "delta"]
    .map(participant => place.attach(participant)
      .then(({ stdout }) => JSON.parse(stdout).ok, error => error.stdout ?? error.message)));

  assert.deepEqual(outcomes, [true, true, true, true],
    `an agent could not open a workspace because another was opening it: ${
      JSON.stringify(outcomes.filter(outcome => outcome !== true))}`);
});

test("a directory belonging to another workspace is still refused", async t => {
  const place = await freshWorkspace(t);
  await place.attach("alpha");

  // Tolerating the race must not tolerate adopting someone else's store. What
  // decides it is the identity on disk, not whose bytes arrived first.
  const workspaces = path.join(place.dataHome, "acc", "workspaces");
  const [existing] = await readdir(workspaces);
  const file = path.join(workspaces, existing, "protocol.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file,
    `${JSON.stringify({ ...record, workspaceId: "workspace_someone_else" })}\n`);

  const refused = await place.attach("beta").then(() => null, error => error);

  assert.notEqual(refused, null, "a store belonging to another workspace was adopted");
  assert.match(refused.stdout, /different workspace/);
});
