import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);

test("installed live setup discloses permissions, diagnoses them, and reverses only its unchanged bundle", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async t => {
  const packed = await createPackedAcc(t);
  await packed.setClientVersions({ codex: "0.153.4" });
  const config = path.join(packed.clientHome, ".codex", "config.toml");
  const before = 'model = "user-model"\n[features]\nnetwork_proxy = false\nother = true\n';
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, before);
  const human = args => run(process.execPath, [packed.accBin, ...args, "--home", packed.clientHome],
    { cwd: packed.project, env: packed.env });
  const args = ["install", "--adapter", "codex", "--delivery", "actionable"];
  assert.match((await human([...args, "--dry-run"])).stdout, /network proxy/);
  assert.equal(await readFile(config, "utf8"), before);
  assert.match((await human(args)).stdout, /network proxy/);
  const generated = await readFile(config, "utf8");
  assert.match(generated, /default_permissions = "acc-workspace"/);
  const doctor = await packed.acc(["doctor", "--home", packed.clientHome]);
  assert.equal(doctor.adapters.find(entry => entry.adapterId === "codex").outgoingDelivery.state, "configured");
  assert.match((await human(["doctor"])).stdout, /outgoing live delivery: local socket permissions configured/);
  assert.match((await human(["doctor"])).stdout, /codex app-server daemon start/);
  assert.ok(doctor.remediation.some(line => line.includes("codex app-server daemon start")));
  await writeFile(config, generated.replace("network_proxy = true", "network_proxy = false"));
  assert.match((await human(["doctor"])).stdout, /outgoing live delivery: sender permissions unverified/);
  assert.match((await human(["uninstall", "--adapter", "codex"])).stdout, /customized native permissions were preserved/);
  assert.match(await readFile(config, "utf8"), /default_permissions = "acc-workspace"/);
  // Restore the unchanged generated file to verify recorded reinstall/removal.
  await writeFile(config, generated);
  await human(args);
  await human(["uninstall", "--adapter", "codex"]);
  assert.equal(await readFile(config, "utf8"), before);
});
