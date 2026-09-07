import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { crashHook } from "../helpers/crash-hook.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

// SIGKILL of fixture hook processes, not native-model or power-loss evidence.
test("installed hook crash recovery preserves one exact owner", async t => {
  const packed = await createPackedAcc(t);
  const flags = binding => ["--session", binding.accSessionId, "--generation", binding.generation];
  const startPayload = id => ({ hook_event_name: "SessionStart", session_id: id,
    cwd: packed.project, source: "startup" });
  const start = id => packed.hook("claude_code", startPayload(id), { ACC_PARTICIPANT: id });
  const end = id => packed.hook("claude_code", { ...startPayload(id), hook_event_name: "SessionEnd" });

  for (const boundary of ["after-open", "before-binding-publish"]) {
    for (const mode of ["solo", "durable"]) {
      await t.test(`${mode} start killed ${boundary} resumes its original generation`, async () => {
        // Each case gets its own data home while sharing one installed archive.
        const casePacked = { ...packed, env: { ...packed.env,
          ACC_DATA_HOME: path.join(packed.root, `${mode}-${boundary}`) } };
        const cli = args => packed.acc(args, { ACC_DATA_HOME: casePacked.env.ACC_DATA_HOME });
        if (mode === "durable") {
          await cli(["attach", "--participant", "peer1"]);
          await cli(["attach", "--participant", "peer2"]);
        }
        const id = `${mode}-${boundary}`;
        const { details } = await crashHook(casePacked, { boundary,
          payload: startPayload(id), participantId: id });
        const sessionId = details.sessionId ?? details.accSessionId;
        const before = (await cli(["status"])).participants.filter(p => p.participantId === id);
        assert.equal(before.length, 1);
        assert.equal(before[0].sessionId, sessionId);
        await packed.hook("claude_code", startPayload(id), {
          ACC_PARTICIPANT: id, ACC_DATA_HOME: casePacked.env.ACC_DATA_HOME });
        const rows = (await cli(["status"])).participants.filter(p => p.participantId === id);
        assert.deepEqual(rows.map(p => p.sessionId), [sessionId]);
        await cli(["heartbeat", "--session", sessionId, "--generation", details.generation]);
        await cli(["work", "--session", sessionId, "--generation", details.generation,
          "--summary", "recovered after crash"]);
        const state = await cli(["sync", "--scope", "full"]);
        if (mode === "solo") {
          assert.equal(state.snapshot.workspace, null);
          assert.deepEqual(state.events, []);
        }
      });
    }
  }

  await t.test("an unused pre-binding is not offered as a usable owner and retry opens normally", async () => {
    const id = "before-open";
    await crashHook(packed, { boundary: "before-open", payload: startPayload(id), participantId: id });
    const pending = await packed.findBinding(id);
    // A header naming a session that never opened sends every subsequent CLI call to exit 5.
    const turn = await packed.beforeTurn({ adapterId: "claude_code", harnessSessionId: id });
    assert.doesNotMatch(turn.stdout, /ACC CLI|--generation/);
    await start(id);
    const current = await packed.findBinding(id);
    assert.ok(current);
    if (pending !== null) assert.notEqual(current.generation, pending.generation);
    await packed.acc(["heartbeat", ...flags(current)]);
    assert.equal((await packed.acc(["status"])).participants.filter(p => p.participantId === id).length, 1);
    await end(id);
  });

  await t.test("a start interrupted after open cannot resurrect an owner closed through CLI", async () => {
    const id = "closed-after-crash";
    const { details } = await crashHook(packed, { boundary: "after-open", payload: startPayload(id),
      participantId: id });
    const old = { accSessionId: details.sessionId, generation: details.generation };
    await packed.acc(["detach", ...flags(old)]);
    await start(id);
    const current = await packed.findBinding(id);
    assert.notEqual(current.generation, old.generation);
    assert.ok(await packed.accError(["heartbeat", ...flags(old)]));
    await packed.acc(["heartbeat", ...flags(current)]);
    await end(id);
  });

  for (const mode of ["solo", "durable"]) {
    await t.test(`${mode} repeating an end killed after close clears its binding without another close event`, async () => {
      const id = `end-retry-${mode}`;
      if (mode === "durable") {
        await packed.acc(["attach", "--participant", "end-peer1"]);
        await packed.acc(["attach", "--participant", "end-peer2"]);
      }
      await start(id);
      const original = await packed.findBinding(id);
      await crashHook(packed, { boundary: "after-close",
        payload: { ...startPayload(id), hook_event_name: "SessionEnd" }, participantId: id });
      assert.ok(await packed.findBinding(id));
      const before = await packed.acc(["sync", "--scope", "full"]);
      await end(id);
      assert.equal(await packed.findBinding(id), null);
      assert.deepEqual(await packed.acc(["sync", "--scope", "full"]), before);
      await start(id);
      const next = await packed.findBinding(id);
      assert.notEqual(next.generation, original.generation);
      await end(id);
    });
  }

  await t.test("a truncated identity record fails open without adding another owner", async () => {
    const id = "truncated-binding";
    await start(id);
    const names = await readdir(packed.dataHome, { recursive: true });
    for (const name of names.filter(name => name.endsWith(".json"))) {
      const file = path.join(packed.dataHome, name);
      const record = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (record?.harnessSessionId !== id) continue;
      delete record.generation;
      await writeFile(file, JSON.stringify(record));
    }
    const before = (await packed.acc(["status"])).participants;
    const outcome = await start(id);
    assert.deepEqual((await packed.acc(["status"])).participants, before);
    assert.doesNotMatch(outcome.stdout, /ACC CLI/);
    assert.deepEqual(await readdir(packed.project), []);
  });
});
