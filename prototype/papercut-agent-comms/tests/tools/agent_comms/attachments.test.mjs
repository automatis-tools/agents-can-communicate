import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import {
  describeAttachment,
  verifyAttachment,
} from "../../../tools/agents/lib/attachments.mjs";
import { createBusFixture } from "./helpers.mjs";

const COMMIT = "b".repeat(40);

function attachmentContext(fixture) {
  return {
    paths: fixture.paths,
    repoRoot: fixture.repo,
  };
}

test("committed repository attachment records actual digest and size", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  await mkdir(path.join(fixture.repo, "docs"));
  await writeFile(path.join(fixture.repo, "docs/evidence.txt"), "evidence\n");

  assert.deepEqual(
    await describeAttachment(attachmentContext(fixture), {
      path: "docs/evidence.txt",
      ephemeral: false,
      commit: COMMIT,
    }),
    {
      path: "docs/evidence.txt",
      sha256: "bdcf4c994585af6dd6cb1cfbff78bcc73ab27dc30a299db5bb83766ca05b5de4",
      size: 9,
      ephemeral: false,
      commit: COMMIT,
    },
  );
});

test("ephemeral artifact records actual digest and size", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  await writeFile(path.join(fixture.paths.artifacts, "render.txt"), "artifact bytes\n");

  assert.deepEqual(
    await describeAttachment(attachmentContext(fixture), {
      path: ".agents/artifacts/render.txt",
      ephemeral: true,
    }),
    {
      path: ".agents/artifacts/render.txt",
      sha256: "59bd16dfc39e768f82bb8ec74467e571e80ed284683b586f077dbf1aa2483ecd",
      size: 15,
      ephemeral: true,
    },
  );
});

test("attachment paths cannot be absolute or escape their allowed root", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const external = path.join(fixture.root, "external.txt");
  await writeFile(external, "outside\n");
  const context = attachmentContext(fixture);

  await assert.rejects(
    describeAttachment(context, { path: external, ephemeral: false }),
    error => error.exitCode === EXIT.DATA,
  );
  await assert.rejects(
    describeAttachment(context, { path: "../external.txt", ephemeral: false }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("attachment checks the real path before allowing a symlink", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const external = path.join(fixture.root, "external.txt");
  await writeFile(external, "outside\n");
  await symlink(external, path.join(fixture.repo, "linked.txt"));

  await assert.rejects(
    describeAttachment(attachmentContext(fixture), {
      path: "linked.txt",
      ephemeral: false,
    }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("missing attachment is rejected as invalid data", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);

  await assert.rejects(
    describeAttachment(attachmentContext(fixture), {
      path: "docs/missing.txt",
      ephemeral: false,
    }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("verification recomputes checksum and byte size", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  await writeFile(path.join(fixture.repo, "evidence.txt"), "evidence\n");
  const context = attachmentContext(fixture);
  const valid = await describeAttachment(context, {
    path: "evidence.txt",
    ephemeral: false,
    commit: COMMIT,
  });

  await verifyAttachment(context, valid);
  await assert.rejects(
    verifyAttachment(context, { ...valid, sha256: "0".repeat(64) }),
    error => error.exitCode === EXIT.DATA,
  );
  await assert.rejects(
    verifyAttachment(context, { ...valid, size: 8 }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("ephemeral attachment cannot claim a commit", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  await writeFile(path.join(fixture.paths.artifacts, "render.txt"), "artifact bytes\n");

  await assert.rejects(
    describeAttachment(attachmentContext(fixture), {
      path: ".agents/artifacts/render.txt",
      ephemeral: true,
      commit: COMMIT,
    }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("canonical artifact cannot be described as a committed repository file", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  await writeFile(path.join(fixture.paths.artifacts, "render.txt"), "artifact bytes\n");
  const context = {
    paths: fixture.paths,
    repoRoot: fixture.root,
  };

  await assert.rejects(
    describeAttachment(context, {
      path: ".agents/artifacts/render.txt",
      ephemeral: false,
      commit: COMMIT,
    }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("repository symlink into artifacts remains ephemeral", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const artifact = path.join(fixture.paths.artifacts, "render.txt");
  await writeFile(artifact, "artifact bytes\n");
  await symlink(artifact, path.join(fixture.root, "linked-artifact.txt"));
  const context = {
    paths: fixture.paths,
    repoRoot: fixture.root,
  };

  await assert.rejects(
    describeAttachment(context, {
      path: "linked-artifact.txt",
      ephemeral: false,
      commit: COMMIT,
    }),
    error => error.exitCode === EXIT.DATA,
  );
});
