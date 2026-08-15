import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import {
  createBusPaths,
  ensureBusLayout,
  resolveBusDir,
} from "../../../tools/agents/lib/paths.mjs";

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pw2-agent-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("relative bus overrides are rejected as invalid data", async () => {
  await assert.rejects(
    resolveBusDir({
      cwd: "/checkout",
      env: { PW2_AGENT_BUS_DIR: "relative/.agents" },
      runGit: () => assert.fail("Git discovery must not run for an override"),
    }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("layout creation rejects a symlinked bus root", async t => {
  const root = await temporaryDirectory(t);
  const outside = path.join(root, "outside");
  const bus = path.join(root, ".agents");
  await mkdir(outside);
  await symlink(outside, bus);

  await assert.rejects(
    ensureBusLayout(createBusPaths(bus)),
    error => error.exitCode === EXIT.DATA,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("layout creation rejects a symlinked managed directory", async t => {
  const root = await temporaryDirectory(t);
  const bus = path.join(root, ".agents");
  const outside = path.join(root, "outside");
  await mkdir(bus);
  await mkdir(outside);
  await symlink(outside, path.join(bus, "inbox"));

  await assert.rejects(
    ensureBusLayout(createBusPaths(bus)),
    error => error.exitCode === EXIT.DATA,
  );
  assert.deepEqual(await readdir(outside), []);
});
