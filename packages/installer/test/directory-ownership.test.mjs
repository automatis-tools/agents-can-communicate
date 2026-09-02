import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPlan } from "../src/apply.mjs";
import { loadOwnership, recordInstall, removeEmptyOwnedDirectories }
  from "../src/ownership.mjs";

async function fixture(t, { preexistingParent = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-parent-own-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const dataHome = path.join(root, "data");
  const parent = path.join(home, ".fixture");
  const plugins = path.join(parent, "plugins");
  const target = path.join(plugins, "acc");
  await mkdir(home, { recursive: true });
  if (preexistingParent) await mkdir(parent);

  const adapter = {
    id: "fixture",
    install: async () => {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "plugin.json"), "{}\n");
      return { changes: [target], diagnostics: [] };
    },
    uninstall: async () => ({ changes: [], diagnostics: [] }),
  };
  const operation = { adapterId: adapter.id, artifacts: [{ path: target, kind: "tree" }] };
  const plan = action => ({ action, skipped: [], operations: [{ ...operation, action }] });
  const context = { home };
  return { adapter, context, dataHome, home, parent, plugins, plan };
}

test("uninstall removes only empty ancestor directories created for an install", async t => {
  const place = await fixture(t);
  await applyPlan({ plan: place.plan("install"), adapters: [place.adapter],
    context: place.context, dataHome: place.dataHome });
  await applyPlan({ plan: place.plan("install"), adapters: [place.adapter],
    context: place.context, dataHome: place.dataHome });

  const [record] = (await loadOwnership({ dataHome: place.dataHome })).installs;
  assert.deepEqual(record.createdDirectories, [place.parent, place.plugins]);

  const result = await applyPlan({ plan: place.plan("uninstall"),
    adapters: [place.adapter], context: place.context, dataHome: place.dataHome });
  assert.deepEqual(result.operations[0].removedDirectories,
    [place.plugins, place.parent]);
  assert.deepEqual(await readdir(place.home), []);
});

test("a pre-existing empty ancestor remains after uninstall", async t => {
  const place = await fixture(t, { preexistingParent: true });
  await applyPlan({ plan: place.plan("install"), adapters: [place.adapter],
    context: place.context, dataHome: place.dataHome });
  await applyPlan({ plan: place.plan("uninstall"), adapters: [place.adapter],
    context: place.context, dataHome: place.dataHome });

  assert.deepEqual(await readdir(place.home), [".fixture"]);
  assert.deepEqual(await readdir(place.parent), []);
});

test("user content prevents removal of recorded ancestor directories", async t => {
  const place = await fixture(t);
  await applyPlan({ plan: place.plan("install"), adapters: [place.adapter],
    context: place.context, dataHome: place.dataHome });
  await writeFile(path.join(place.plugins, "mine.txt"), "keep\n");

  const result = await applyPlan({ plan: place.plan("uninstall"),
    adapters: [place.adapter], context: place.context, dataHome: place.dataHome });
  assert.deepEqual(result.operations[0].removedDirectories, []);
  assert.deepEqual(result.operations[0].keptDirectories,
    [place.plugins, place.parent]);
  assert.deepEqual(await readdir(place.plugins), ["mine.txt"]);
});

test("an older ownership record without createdDirectories removes no parents", async t => {
  const place = await fixture(t, { preexistingParent: true });
  await place.adapter.install();
  // recordInstall's default models records written before directory ownership existed.
  await recordInstall({ dataHome: place.dataHome, adapterId: "fixture", version: null,
    artifacts: place.plan("install").operations[0].artifacts });

  const result = await applyPlan({ plan: place.plan("uninstall"),
    adapters: [place.adapter], context: place.context, dataHome: place.dataHome });
  assert.deepEqual(result.operations[0].removedDirectories, []);
  assert.deepEqual(await readdir(place.parent), ["plugins"]);
});

test("a recorded directory outside the authorized client home is never removed", async t => {
  const place = await fixture(t);
  const foreign = path.join(path.dirname(place.home), "foreign-empty");
  await mkdir(foreign);

  const result = await removeEmptyOwnedDirectories({ home: place.home,
    directories: [foreign] });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, [foreign]);
  assert.deepEqual(await readdir(foreign), []);
});
