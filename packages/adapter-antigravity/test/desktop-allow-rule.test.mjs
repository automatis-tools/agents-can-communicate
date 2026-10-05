import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import nodeTest from "node:test";

import { inspectDesktopRule } from "../src/desktop-allow-rule.mjs";
import { detectAntigravity, installAntigravity, uninstallAntigravity } from "../src/install.mjs";
import { agyHome } from "./agy-home.mjs";
import { NO_ALLOW_RULE_ON_WINDOWS } from "../../../tests/helpers/platform-scope.mjs";

const test = (name, fn) => nodeTest(name, { skip: NO_ALLOW_RULE_ON_WINDOWS }, fn);

// What Antigravity 2.19.1 wrote to ~/.gemini/config/config.json on 2026-10-04
// when its "always allow" was picked for ACC's wrapper, the host name changed.
const desktopConfig = wrapper => ({
  plugins: { acc: { enabled: true } },
  userSettings: { globalPermissionGrants: { allow: [`command(${wrapper})`] },
    permissionGrantsV2Migrated: true, remoteControlHostname: "host-1",
    sandboxEnabledAtV2Migration: true },
});

async function withConfig(t, value) {
  const fixture = await agyHome(t);
  await fixture.write(fixture.theirs);
  const file = path.join(fixture.home, ".gemini", "config", "config.json");
  if (value !== undefined) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  return { ...fixture, file, readConfig: async () => JSON.parse(await readFile(file, "utf8")) };
}

test("install allows ACC's wrapper where the desktop app keeps its grants", async t => {
  const fixture = await withConfig(t, { plugins: { acc: { enabled: true } },
    userSettings: { permissionGrantsV2Migrated: true, sandboxEnabledAtV2Migration: true } });

  const result = await installAntigravity(fixture.context);

  assert.deepEqual(await fixture.readConfig(), { plugins: { acc: { enabled: true } },
    userSettings: { permissionGrantsV2Migrated: true, sandboxEnabledAtV2Migration: true,
      globalPermissionGrants: { allow: [fixture.rule] } } });
  assert.equal(result.changes.includes(fixture.file), true);
  assert.equal(result.diagnostics.some(line => line.includes(fixture.rule) && /desktop app/.test(line)), true);
  assert.equal((await inspectDesktopRule(fixture.context)).owned, true);
});

test("a machine where the desktop app never ran gets no config.json from ACC", async t => {
  const fixture = await withConfig(t);

  const result = await installAntigravity(fixture.context);

  assert.equal(await stat(fixture.file).then(() => true, () => false), false);
  assert.equal(result.diagnostics.some(line => /desktop app/.test(line)), false);
  assert.equal((await inspectDesktopRule(fixture.context)).state, "absent");
});

test("the operator's own grant is left as theirs, at install and at uninstall", async t => {
  const fixture = await withConfig(t, {});
  await writeFile(fixture.file, `${JSON.stringify(desktopConfig(fixture.wrapper), null, 2)}\n`);
  const before = await readFile(fixture.file, "utf8");

  await installAntigravity(fixture.context);
  assert.equal(await readFile(fixture.file, "utf8"), before, "no second copy of the same grant");
  assert.equal((await inspectDesktopRule(fixture.context)).owned, false);
  await uninstallAntigravity(fixture.context);
  assert.equal(await readFile(fixture.file, "utf8"), before);
});

test("uninstall takes back the rule and the containers ACC made, and nothing else", async t => {
  const original = { plugins: { acc: { enabled: true } } };
  const fixture = await withConfig(t, original);

  await installAntigravity(fixture.context);
  const result = await uninstallAntigravity(fixture.context);

  assert.deepEqual(await fixture.readConfig(), original);
  assert.equal(result.diagnostics.some(line => line.includes(fixture.rule)), true);
});

test("a config.json that does not read is left byte for byte, and said so", async t => {
  const fixture = await withConfig(t, "{ not json");

  const result = await installAntigravity(fixture.context);

  assert.equal(await readFile(fixture.file, "utf8"), "{ not json");
  assert.equal(result.needsAction?.some(line => line.includes("is not valid JSON")), true);
  for (const broken of [{ userSettings: [] }, { userSettings: { globalPermissionGrants: 1 } },
    { userSettings: { globalPermissionGrants: { allow: "x" } } }]) {
    await writeFile(fixture.file, JSON.stringify(broken));
    assert.equal((await inspectDesktopRule(fixture.context)).state, "unreadable", JSON.stringify(broken));
  }
});

test("doctor reports the desktop grant when the desktop app is there", async t => {
  const fixture = await withConfig(t, { userSettings: {} });

  const before = await detectAntigravity({ ...fixture.context, clientVersion: null });
  assert.equal(before.diagnostics.some(line => /desktop app\) asks before each ACC command/.test(line)), true);
  await installAntigravity(fixture.context);
  const after = await detectAntigravity({ ...fixture.context, clientVersion: null });
  assert.equal(after.diagnostics.some(line => /without an approval prompt in Antigravity \(the desktop app\)/
    .test(line)), true);
});
