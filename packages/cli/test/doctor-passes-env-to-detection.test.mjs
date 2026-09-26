import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { diagnoseAdapters } from "../src/doctor-command.mjs";

// Doctor re-runs detection to report native-delivery state, and detection
// resolves the real client executable from PATH. This holds doctor to handing
// detection the environment install uses, without a client on the machine: an
// injected detect captures the context doctor builds.
test("doctor hands detection the runtime environment it resolves the client from", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "acc-doctor-env-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  let seen = null;
  const detect = async ({ context }) => { seen = context; return []; };
  const runtime = { platform: process.platform,
    env: { HOME: home, APPDATA: home, SHELL: "/bin/zsh" } };

  await diagnoseAdapters({ options: {}, runtime, detect });

  assert.notEqual(seen, null, "detection must be reached");
  assert.equal(seen.env.SHELL, "/bin/zsh",
    "doctor must pass the environment detection resolves PATH and the real executable from");
});
