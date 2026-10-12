import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ADAPTER_PACKAGES, loadedModules, repo } from "../helpers/loaded-modules.mjs";

// A hook starts a process on every turn, and loading its modules was most of
// that start on Windows: 195 files, about a millisecond each on windows-latest,
// of which every other client's adapter, the command line and the installer
// were never run. A hook now loads its own client's adapter and the parts of
// the CLI and installer a hook calls.
test("a hook process loads its own adapter and none of the command line", async t => {
  const { from } = await loadedModules(t, [path.join(repo, "bin", "acc-hook.mjs"), "codex"],
    { stdin: "{}" });

  for (const other of ADAPTER_PACKAGES.filter(pkg => pkg !== "adapter-codex")) {
    assert.deepEqual(from(other), [], `a codex hook loaded ${other}`);
  }
  assert.notDeepEqual(from("adapter-codex"), [], "the hook never loaded its own adapter");
  for (const command of ["install-command.mjs", "doctor-command.mjs", "update-command.mjs",
    "main.mjs", "args.mjs"]) {
    assert.deepEqual(from("cli").filter(url => url.endsWith(`/${command}`)), [],
      `a hook loaded the CLI's ${command}`);
  }
  for (const part of ["detect.mjs", "apply.mjs", "plan.mjs"]) {
    assert.deepEqual(from("installer").filter(url => url.endsWith(`/${part}`)), [],
      `a hook loaded the installer's ${part}`);
  }
});
