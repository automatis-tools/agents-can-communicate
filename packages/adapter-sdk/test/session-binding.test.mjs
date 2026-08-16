import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { clearSessionBinding, loadSessionBinding, storeSessionBinding }
  from "../src/session-binding.mjs";

async function runtimeDir(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "acc-binding-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const binding = { harnessSessionId: "abc-123", accSessionId: "session_a",
  generation: "generation_a" };

test("a binding survives between two separate hook processes", async t => {
  const dir = await runtimeDir(t);
  // Hook executables are ephemeral: the process that attaches is gone by the
  // time the next hook fires, so the exact generation has to be recoverable.
  await storeSessionBinding({ runtimeDir: dir, ...binding });

  const loaded = await loadSessionBinding({ runtimeDir: dir,
    harnessSessionId: binding.harnessSessionId });

  assert.deepEqual(loaded, { accSessionId: "session_a", generation: "generation_a" });
});

test("an unknown harness session loads as null rather than throwing", async t => {
  const dir = await runtimeDir(t);

  assert.equal(await loadSessionBinding({ runtimeDir: dir, harnessSessionId: "absent" }), null);
});

test("clearing a binding removes it and is safe to repeat", async t => {
  const dir = await runtimeDir(t);
  await storeSessionBinding({ runtimeDir: dir, ...binding });

  await clearSessionBinding({ runtimeDir: dir, harnessSessionId: binding.harnessSessionId });
  await clearSessionBinding({ runtimeDir: dir, harnessSessionId: binding.harnessSessionId });

  assert.equal(await loadSessionBinding({ runtimeDir: dir,
    harnessSessionId: binding.harnessSessionId }), null);
});

test("re-attaching replaces the binding rather than accumulating generations", async t => {
  const dir = await runtimeDir(t);
  await storeSessionBinding({ runtimeDir: dir, ...binding });

  await storeSessionBinding({ runtimeDir: dir, ...binding, generation: "generation_b" });

  const loaded = await loadSessionBinding({ runtimeDir: dir,
    harnessSessionId: binding.harnessSessionId });
  assert.equal(loaded.generation, "generation_b");
  assert.equal((await readdir(path.join(dir, "bindings"))).length, 1);
});

test("a harness session id becomes a safe filename, never a path", async t => {
  const dir = await runtimeDir(t);

  // Harness ids are foreign input. They must not be able to select the file.
  await storeSessionBinding({ runtimeDir: dir, ...binding,
    harnessSessionId: "../../escape" });

  const files = await readdir(path.join(dir, "bindings"));
  assert.equal(files.length, 1);
  assert.equal(files[0].includes("/"), false);
  assert.equal(files[0].includes(".."), false);
  assert.deepEqual(await loadSessionBinding({ runtimeDir: dir,
    harnessSessionId: "../../escape" }),
  { accSessionId: "session_a", generation: "generation_a" });
});

test("two harness sessions keep independent bindings", async t => {
  const dir = await runtimeDir(t);
  await storeSessionBinding({ runtimeDir: dir, ...binding });
  await storeSessionBinding({ runtimeDir: dir, harnessSessionId: "def-456",
    accSessionId: "session_b", generation: "generation_b" });

  assert.equal((await loadSessionBinding({ runtimeDir: dir,
    harnessSessionId: "abc-123" })).accSessionId, "session_a");
  assert.equal((await loadSessionBinding({ runtimeDir: dir,
    harnessSessionId: "def-456" })).accSessionId, "session_b");
});

test("a corrupt binding is a data error, not a silent miss", async t => {
  const dir = await runtimeDir(t);
  await storeSessionBinding({ runtimeDir: dir, ...binding });
  const file = path.join(dir, "bindings",
    (await readdir(path.join(dir, "bindings")))[0]);
  await writeFile(file, "{not-json");

  // Returning null here would make a hook silently open a second session and
  // orphan the first. Failing closed is the honest outcome.
  await assert.rejects(loadSessionBinding({ runtimeDir: dir,
    harnessSessionId: binding.harnessSessionId }), error => error.code === EXIT.DATA);
});

test("a binding records nothing about the conversation", async t => {
  const dir = await runtimeDir(t);
  await storeSessionBinding({ runtimeDir: dir, ...binding });
  const file = path.join(dir, "bindings", (await readdir(path.join(dir, "bindings")))[0]);
  const { readFile } = await import("node:fs/promises");

  const stored = JSON.parse(await readFile(file, "utf8"));

  // Bindings live outside the project and carry identity only: no prompt, no
  // transcript, no harness state.
  assert.deepEqual(Object.keys(stored).sort(),
    ["accSessionId", "generation", "harnessSessionId", "schemaVersion"]);
});
