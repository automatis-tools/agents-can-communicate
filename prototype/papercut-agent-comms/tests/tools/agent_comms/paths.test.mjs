import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createBusPaths,
  ensureBusLayout,
  resolveBusDir,
} from "../../../tools/agents/lib/paths.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { createGitWorktreeFixture, pathExists } from "./helpers.mjs";

test("environment override wins", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const bus = await resolveBusDir({
    cwd: fixture.root,
    env: { PW2_AGENT_BUS_DIR: fixture.bus },
    runGit: () => assert.fail("Git discovery must not run for an override"),
  });

  assert.equal(bus, fixture.bus);
});

test("main and linked worktree resolve one shared bus", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);

  assert.equal(await fixture.resolveFrom(fixture.main), fixture.bus);
  assert.equal(await fixture.resolveFrom(fixture.worktree), fixture.bus);
});

test("ambiguous Git common directories require an override", async () => {
  await assert.rejects(
    resolveBusDir({
      cwd: "/repo/worktree",
      env: {},
      runGit: async () => "/repo/bare.git\n",
    }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("bus paths expose the complete version-one layout", () => {
  const paths = createBusPaths("/checkout/.agents");

  assert.equal(paths.protocol, "/checkout/.agents/protocol.json");
  for (const directory of [
    "registry",
    "presence",
    "inbox",
    "seen",
    "acknowledgements",
    "claims",
    "handoffs",
    "archive",
    "artifacts",
    "locks",
    "quarantine",
    "tmp",
  ]) {
    assert.equal(paths[directory], path.join("/checkout/.agents", directory));
  }
  assert.equal(Object.isFrozen(paths), true);
});

test("layout creation is idempotent and preserves existing records", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const paths = createBusPaths(fixture.bus);
  await ensureBusLayout(paths);
  const record = path.join(paths.registry, "visual.json");
  await writeFile(record, "existing-record\n", "utf8");

  await ensureBusLayout(paths);

  assert.equal(await readFile(record, "utf8"), "existing-record\n");
  for (const directory of [
    paths.registry,
    paths.presence,
    paths.inbox,
    paths.seen,
    paths.acknowledgements,
    paths.claims,
    paths.handoffs,
    paths.archive,
    paths.artifacts,
    paths.locks,
    paths.quarantine,
    paths.tmp,
  ]) {
    assert.equal(await pathExists(directory), true);
  }
});
