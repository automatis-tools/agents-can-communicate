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
    env: { HOME: home, LOCALAPPDATA: home, SHELL: "/bin/zsh" } };

  await diagnoseAdapters({ options: {}, runtime, detect });

  assert.notEqual(seen, null, "detection must be reached");
  assert.equal(seen.env.SHELL, "/bin/zsh",
    "doctor must pass the environment detection resolves PATH and the real executable from");
});

// Doctor judges the Codex permission profile against every socket ACC delivers
// to; a context without them would call an incomplete profile configured.
test("doctor hands detection every receiving adapter's sockets for the runtime platform", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "acc-doctor-receivers-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let seen = null;
  const detect = async ({ context }) => { seen = context; return []; };
  await diagnoseAdapters({ options: {}, runtime: { platform: "linux",
    env: { HOME: home, XDG_RUNTIME_DIR: "/run/user/4242" } }, detect });
  assert.ok(seen.receiverSockets.includes("/run/user/4242/cc-socks"));
  assert.ok(seen.receiverSockets.includes(
    path.join(home, ".codex", "app-server-control", "app-server-control.sock")));
  await diagnoseAdapters({ options: {}, runtime: { platform: "win32",
    env: { HOME: home, LOCALAPPDATA: home } }, detect });
  assert.equal(seen.receiverSockets.some(item => item.includes("cc-socks")), false,
    "the runtime platform, not the host's, decides what the receivers declare");
});
