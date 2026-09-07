import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { SCHEMA_VERSION } from "@agents-can-communicate/protocol";

// Pause after real temp-file fsync, before the destination's rename/link.
// An entry-only deadline check misses this filesystem preparation window.
test("atomic publication checks its deadline after preparing bytes", async t => {
  let entered, release;
  let blocked;
  globalThis.accAtomicDeadlinePause = async () => { entered(); await blocked; };
  const instrumentation = registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith("/atomic-json.mjs")) {
      const source = Buffer.from(result.source).toString();
      const needle = "      await rename(temporary, destination);\n      await syncDirectory(destinationDir);";
      assert.equal(source.split(needle).length, 2);
      return { ...result, source: source.replace(needle,
        `${needle}\n      await globalThis.accAtomicPublished?.(destination);`) };
    }
    if (!url.endsWith("/atomic-json.mjs?deadline-proof")) return result;
    const source = Buffer.from(result.source).toString();
    const needle = "    await handle.writeFile(bytes);\n    await handle.sync();";
    assert.equal(source.split(needle).length, 2);
    return { ...result, source: source.replace(needle,
      `${needle}\n    await globalThis.accAtomicDeadlinePause();`) };
  } });
  t.after(() => {
    instrumentation.deregister();
    delete globalThis.accAtomicDeadlinePause;
    delete globalThis.accAtomicPublished;
  });
  const { publishAtomic } = await import("../src/atomic-json.mjs?deadline-proof");
  for (const replace of [false, true]) {
    await t.test(`${replace ? "replacement" : "immutable"} publication preserves the destination on expiry`, async t => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-atomic-deadline-")));
      t.after(() => rm(root, { recursive: true, force: true }));
      const destination = path.join(root, "record.json");
      const original = Buffer.from("original\n");
      if (replace) await writeFile(destination, original);
      const reached = new Promise(resolve => { entered = resolve; });
      blocked = new Promise(resolve => { release = resolve; });
      const deadlineAt = Date.now() + 1000;
      const pending = publishAtomic(destination, Buffer.from("late\n"),
        { root, tmpDir: path.join(root, "tmp"), replace, deadlineAt });
      const settled = pending.then(value => ({ value }), error => ({ error }));
      try {
        await reached;
        while (Date.now() <= deadlineAt) await delay(Math.max(1, deadlineAt - Date.now() + 1));
      } finally { release(); }
      assert.match((await settled).error?.message ?? "no error", /deadline/);
      if (replace) assert.deepEqual(await readFile(destination), original);
      else await assert.rejects(readFile(destination), { code: "ENOENT" });
      await publishAtomic(destination, Buffer.from("retry\n"),
        { root, tmpDir: path.join(root, "tmp"), replace });
      assert.equal(await readFile(destination, "utf8"), "retry\n");
    });
  }

  await t.test("an accepted ephemeral record finishes its presence marker after expiry", async t => {
    const { openFilesystemStore } = await import("../src/store.mjs");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-ephemeral-accepted-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    let sequence = 0;
    const options = { root, workspaceId: "workspace_a",
      clock: { now: () => new Date().toISOString() }, ids: { next: kind => `${kind}_${++sequence}` } };
    const observer = await openFilesystemStore(options);
    const record = { schemaVersion: SCHEMA_VERSION, participantId: "participant_a", workspaceId: "workspace_a",
      displayName: "Accepted", kind: "agent", createdAt: "2026-09-07T00:00:00.000Z" };
    await observer.ephemeral.put("participant", "participant_a", record);
    await observer.ephemeral.delete("participant", "participant_a");
    const deadlineAt = Date.now() + 1000;
    const limited = await openFilesystemStore({ ...options, deadlineAt });
    const reached = new Promise(resolve => { entered = resolve; });
    blocked = new Promise(resolve => { release = resolve; });
    let armed = true;
    globalThis.accAtomicPublished = async destination => {
      if (!armed || !destination.endsWith(path.join("ephemeral", "participant", "participant_a.json"))) return;
      armed = false;
      entered();
      await blocked;
    };
    const pending = limited.ephemeral.put("participant", "participant_a", record);
    try {
      await reached;
      while (Date.now() <= deadlineAt) await delay(Math.max(1, deadlineAt - Date.now() + 1));
    } finally { release(); }
    await pending;
    assert.deepEqual(await observer.ephemeral.get("participant", "participant_a"), record);
  });
});
