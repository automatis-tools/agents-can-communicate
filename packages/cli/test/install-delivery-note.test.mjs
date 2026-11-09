import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runInstallCommand } from "../src/install-command.mjs";
import { writeFakeClient } from "../../../tests/helpers/fake-client.mjs";
import { POSIX_LIVE_TRANSPORT } from "../../../tests/helpers/platform-scope.mjs";

const ANNOUNCED = /turned live delivery on for Kimi/;

async function machine(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-delivery-note-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const bin = path.join(base, "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(home, ".kimi-code"), { recursive: true });
  await writeFakeClient(bin, "kimi", { output: "kimi, version 2.4.0" });
  const dataHome = path.join(base, "data");
  const env = { HOME: home, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1",
    ACC_PROBE_TIMEOUT_MS: "30000", PATH: `${bin}:/usr/bin:/bin` };
  const install = () => runInstallCommand({ options: { home, adapter: "kimi" },
    runtime: { platform: process.platform, env }, action: "install" });
  return { home, install };
}

test("the delivery note names a client only once its install has succeeded",
  { skip: POSIX_LIVE_TRANSPORT }, async t => {
    const { home, install } = await machine(t);
    // Kimi's configuration is a directory here, so writing it fails for this client.
    const blocked = path.join(home, ".kimi-code", "config.toml");
    await mkdir(blocked);

    const failed = await install();

    assert.deepEqual(failed.data.failed.map(entry => entry.adapterId), ["kimi"]);
    assert.doesNotMatch(failed.text, ANNOUNCED);

    await rm(blocked, { recursive: true });
    const installed = await install();

    assert.deepEqual(installed.data.failed, []);
    assert.match(installed.text, ANNOUNCED);
  });
