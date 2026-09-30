import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPlan } from "../src/apply.mjs";
import { loadOwnership } from "../src/ownership.mjs";

test("a failed adapter uninstall keeps ownership authority for an idempotent retry", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-uninstall-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const dataHome = path.join(root, "data");
  const plugin = path.join(home, ".fixture", "plugins", "acc");
  const settings = path.join(home, "settings.json");
  await mkdir(home);
  await writeFile(settings, `${JSON.stringify({ theme: "dark" })}\n`);

  let failUninstall = true;
  const adapter = {
    id: "fixture",
    install: async () => {
      await mkdir(plugin, { recursive: true });
      await writeFile(path.join(plugin, "plugin.json"), "{}\n");
      await writeFile(settings, `${JSON.stringify({ theme: "dark", acc: true })}\n`);
      return { changes: [plugin, settings], diagnostics: [] };
    },
    uninstall: async () => {
      const value = JSON.parse(await readFile(settings, "utf8"));
      delete value.acc;
      await writeFile(settings, `${JSON.stringify(value)}\n`);
      if (failUninstall) {
        failUninstall = false;
        throw new Error("fixture failed after merge cleanup");
      }
      return { changes: [settings], diagnostics: [] };
    },
  };
  const operation = { adapterId: adapter.id, action: "install", artifacts: [
    { path: plugin, kind: "tree" },
    { path: settings, kind: "merge" },
  ] };
  const plan = action => ({ action, skipped: [], operations: [{ ...operation, action }] });
  const context = { home };

  await applyPlan({ plan: plan("install"), adapters: [adapter], context, dataHome });
  const first = await applyPlan({ plan: plan("uninstall"), adapters: [adapter],
    context, dataHome });

  assert.match(first.failed[0].error, /failed after merge cleanup/);
  assert.deepEqual((await loadOwnership({ dataHome })).installs.map(item => item.adapterId),
    ["fixture"], "the failed uninstall discarded its retry authority");
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { theme: "dark" });

  const retried = await applyPlan({ plan: plan("uninstall"), adapters: [adapter],
    context, dataHome });
  assert.deepEqual(retried.failed, []);
  assert.deepEqual((await loadOwnership({ dataHome })).installs, []);
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { theme: "dark" });

  const repeated = await applyPlan({ plan: plan("uninstall"), adapters: [adapter],
    context, dataHome });
  assert.deepEqual(repeated.failed, []);
  assert.deepEqual((await loadOwnership({ dataHome })).installs, []);
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { theme: "dark" });
});

test("a failed owned-directory cleanup keeps authority until a retry succeeds", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-directory-retry-"));
  const home = path.join(root, "home");
  const dataHome = path.join(root, "data");
  const parent = path.join(home, ".fixture");
  const plugin = path.join(parent, "plugins", "acc");
  t.after(async () => {
    await chmod(parent, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(home);

  // POSIX refuses the removal through the parent's mode. Windows has no mode
  // bits there; a directory that is a live process's working directory is
  // refused instead (EBUSY, measured on windows-latest).
  let holder = null;
  const block = async () => {
    if (process.platform !== "win32") return chmod(parent, 0o500);
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { cwd: plugin, stdio: "ignore", windowsHide: true });
    await new Promise(resolve => { holder.once("spawn", resolve); });
  };
  const unblock = async () => {
    if (process.platform !== "win32") return chmod(parent, 0o700);
    if (holder !== null) {
      const exited = new Promise(resolve => { holder.once("exit", resolve); });
      holder.kill();
      await exited;
      holder = null;
    }
  };
  t.after(() => unblock().catch(() => {}));

  let blockCleanup = true;
  const adapter = {
    id: "fixture",
    install: async () => {
      await mkdir(plugin, { recursive: true });
      await writeFile(path.join(plugin, "plugin.json"), "{}\n");
      return { changes: [plugin], diagnostics: [] };
    },
    uninstall: async () => {
      if (blockCleanup) {
        blockCleanup = false;
        await block();
      }
      return { changes: [], diagnostics: [] };
    },
  };
  const operation = { adapterId: adapter.id, artifacts: [{ path: plugin, kind: "tree" }] };
  const plan = action => ({ action, skipped: [], operations: [{ ...operation, action }] });
  const context = { home };

  await applyPlan({ plan: plan("install"), adapters: [adapter], context, dataHome });
  const first = await applyPlan({ plan: plan("uninstall"), adapters: [adapter],
    context, dataHome });

  assert.equal(first.failed.length, 1, "the permission failure never reached cleanup");
  assert.deepEqual((await loadOwnership({ dataHome })).installs.map(item => item.adapterId),
    ["fixture"], "directory cleanup failure discarded its retry authority");

  await unblock();
  const retried = await applyPlan({ plan: plan("uninstall"), adapters: [adapter],
    context, dataHome });
  assert.deepEqual(retried.failed, []);
  assert.deepEqual((await loadOwnership({ dataHome })).installs, []);
});
