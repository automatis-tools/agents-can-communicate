import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { activatePending, listNativeHolds } from "../src/managed-runtime/activation.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { createCoordinationService } from "@agents-can-communicate/core";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { storeSessionBinding } from "@agents-can-communicate/adapter-sdk";
import { createId } from "@agents-can-communicate/protocol";

async function fixture(t) {
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-activation-")));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const root = path.join(dataHome, "acc", "runtime");
  const active = { version: "0.4.0", root: path.join(root, "generations", "old") };
  const pending = { version: "0.4.1", root: path.join(root, "generations", "new") };
  await mkdir(active.root, { recursive: true }); await mkdir(pending.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: path.join(dataHome, "home"), targets: [], notice: null });
  return { root, dataHome, active, pending };
}
async function binding(f, value) {
  const dir = path.join(f.dataHome, "acc", "workspaces", "project", "bindings");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "native.json"), JSON.stringify({ schemaVersion: 1,
    accSessionId: "session_native", generation: "gen_native", harnessSessionId: "native", ...value }));
}

test("native client holds survive finish and age, and unknown PID is never presumed dead", async t => {
  const f = await fixture(t);
  await binding(f, { clientPid: process.pid, closedAt: "2000-01-01T00:00:00Z" });
  assert.equal((await listNativeHolds(f.root)).length, 1);
  let applied = 0;
  const prepare = async () => async () => { applied++; return { failed: [] }; };
  assert.equal((await activatePending(f.root, { prepare })).activated, false);
  assert.equal(applied, 0);
  assert.deepEqual((await readControl(f.root)).active, f.active);
  await binding(f, {});
  assert.equal((await activatePending(f.root, { prepare, pidIsAlive: () => false })).activated, false);
  assert.equal(applied, 0);
});

test("an idle ACC process prevents activation; only confirmed death permits switching", async t => {
  const f = await fixture(t);
  await acquireRuntime(f.root, { kind: "acc-mcp" });
  let applied = 0;
  const prepare = async () => async () => { applied++; return { failed: [] }; };
  assert.equal((await activatePending(f.root, { prepare })).activated, false);
  assert.equal(applied, 0);
  const result = await activatePending(f.root, { prepare, pidIsAlive: () => false });
  assert.equal(result.activated, true);
  assert.equal(applied, 1);
  assert.deepEqual((await readControl(f.root)).active, f.pending);
});

test("partial integration refresh keeps admission closed and retry repairs forward", async t => {
  const f = await fixture(t);
  const marker = path.join(f.dataHome, "first-integration-written");
  const failed = await activatePending(f.root, { prepare: async () => async () => {
    assert.equal((await readControl(f.root)).phase, "activating");
    await assert.rejects(acquireRuntime(f.root), /lock|activation/);
    await writeFile(marker, "candidate");
    return { failed: [{ adapterId: "second", error: "write refused" }] };
  } });
  assert.equal(failed.activated, false);
  const partial = await readControl(f.root);
  assert.equal(partial.phase, "activating");
  assert.deepEqual(partial.active, f.active);
  await assert.rejects(acquireRuntime(f.root), /activation/);
  assert.equal(await readFile(marker, "utf8"), "candidate");
  const repaired = await activatePending(f.root, { prepare: async () => async () => ({ failed: [] }) });
  assert.equal(repaired.activated, true);
  assert.equal((await readControl(f.root)).phase, "ready");
  assert.deepEqual((await readControl(f.root)).active, f.pending);
});

async function mcpBinding(t) {
  const f = await fixture(t);
  const workspaceId = "project", participantId = "mcp_peer";
  const runtimeDir = path.join(f.dataHome, "acc", "workspaces", workspaceId);
  const clock = { now: () => "2026-09-08T12:00:00.000Z" };
  const ids = { next: createId };
  const store = await openFilesystemStore({ root: runtimeDir, workspaceId, clock, ids });
  const service = createCoordinationService({ store, clock, ids });
  const session = await service.openSession({ workspaceId, participantId,
    harness: "mcp", heartbeatCadenceMs: 60_000 });
  await storeSessionBinding({ runtimeDir, harnessSessionId: `mcp:${participantId}:${workspaceId}`,
    accSessionId: session.sessionId, generation: session.generation });
  const file = path.join(runtimeDir, "bindings", (await readdir(path.join(runtimeDir, "bindings")))[0]);
  return { ...f, file, runtimeDir, session, service, record: JSON.parse(await readFile(file, "utf8")) };
}

test("validated MCP continuity survives activation for ephemeral and finished durable owners", async t => {
  for (const finished of [false, true]) {
    const f = await mcpBinding(t);
    if (finished) await f.service.finishSession({ sessionId: f.session.sessionId,
      generation: f.session.generation, goal: "done", clientMessageId: "finish_retry" });
    const bytes = await readFile(f.file, "utf8");
    assert.deepEqual(await listNativeHolds(f.root), []);
    const result = await activatePending(f.root, { prepare: async () => async () => ({ failed: [] }) });
    assert.equal(result.activated, true);
    assert.equal(await readFile(f.file, "utf8"), bytes, "continuity must not be rewritten or removed");
  }
});

test("misleading or ambiguous MCP-like bindings retain native activation holds", async t => {
  const cases = [
    ["prefix only", f => ({ ...f.record, harnessSessionId: "mcp:foreign" })],
    ["wrong workspace", f => ({ ...f.record, harnessSessionId: "mcp:mcp_peer:other" })],
    ["unknown schema", f => ({ ...f.record, schemaVersion: 2 })],
    ["invalid owner id", f => ({ ...f.record, accSessionId: "../outside" })],
    ["missing owner", f => ({ ...f.record, accSessionId: "session_absent" })],
    ["wrong generation", f => ({ ...f.record, generation: "generation_wrong" })],
    ["native pid", f => ({ ...f.record, clientPid: process.pid })],
    ["unknown native pid", f => ({ ...f.record, clientPid: null })],
    ["native metadata", f => ({ ...f.record, clientVersion: "1.2.3" })],
    ["native owner", f => f.record, async f => {
      const file = path.join(f.runtimeDir, "ephemeral", "session", `${f.session.sessionId}.json`);
      const record = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...record, harness: "native" }));
    }],
    ["corrupt owner", f => f.record, f => writeFile(path.join(f.runtimeDir, "ephemeral", "session",
      `${f.session.sessionId}.json`), "{bad")],
    ["symlinked owner directory", f => f.record, async f => {
      const directory = path.join(f.runtimeDir, "ephemeral", "session");
      const outside = path.join(f.dataHome, "external-sessions");
      await rename(directory, outside);
      await symlink(outside, directory);
    }],
    ["wrong filename", f => f.record, async f => {
      await rm(f.file); f.file = path.join(path.dirname(f.file), "unmatched.json");
    }],
  ];
  for (const [label, change, prepare] of cases) {
    const f = await mcpBinding(t);
    await prepare?.(f);
    await writeFile(f.file, JSON.stringify(change(f)));
    assert.equal((await listNativeHolds(f.root)).length, 1, label);
    assert.equal((await activatePending(f.root, { prepare: async () => async () => ({ failed: [] }) }))
      .activated, false, label);
  }
});

test("published 0.3.1 MCP continuity is reusable without migration", async t => {
  const f = await fixture(t);
  const captured = JSON.parse(await readFile(new URL("fixtures/mcp-continuity-0.3.1.json", import.meta.url), "utf8"));
  const root = path.join(f.dataHome, "acc", "workspaces", captured.workspaceId);
  for (const dir of ["bindings", "ephemeral/session"]) await mkdir(path.join(root, dir), { recursive: true });
  const file = path.join(root, "bindings", captured.filename);
  await writeFile(file, JSON.stringify(captured.binding));
  await writeFile(path.join(root, "protocol.json"), JSON.stringify(captured.protocol));
  await writeFile(path.join(root, "ephemeral", "session", `${captured.binding.accSessionId}.json`),
    JSON.stringify(captured.session));
  assert.deepEqual(await listNativeHolds(f.root), []);
  assert.equal((await activatePending(f.root, { prepare: async () => async () => ({ failed: [] }) })).activated, true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), captured.binding);
});
