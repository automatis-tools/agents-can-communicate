import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { diagnoseAdapters } from "../src/doctor-command.mjs";

// Doctor re-runs detection to report native-delivery state. Detection plans a
// fresh shell bootstrap and degrades to `unsupported_shell` whenever the client
// context's shell is not zsh - so if doctor omits the shell it read from the
// environment, a zsh machine with a working shim reads as degraded on every
// `acc doctor`, forever. This holds doctor to handing detection the real shell,
// the way install already does, without a client on the machine: an injected
// detect captures the context doctor builds.
test("doctor hands detection the runtime shell so a zsh install is not misreported", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "acc-doctor-shell-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  let seen = null;
  const detect = async ({ context }) => { seen = context; return []; };
  const runtime = { platform: process.platform,
    env: { HOME: home, APPDATA: home, SHELL: "/bin/zsh" } };

  await diagnoseAdapters({ options: {}, runtime, detect });

  assert.notEqual(seen, null, "detection must be reached");
  assert.equal(seen.shell, "zsh",
    "doctor must pass the login shell, or every zsh install reads as unsupported_shell");
  assert.equal(seen.env.SHELL, "/bin/zsh",
    "doctor must pass the environment detection resolves PATH and the real executable from");
});
