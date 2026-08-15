import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  archiveFileNoReplace,
  listJsonFiles,
  moveFileAtomic,
  readJsonStrict,
  writeJsonAtomic,
} from "../../../tools/agents/lib/atomic-json.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { createBusFixture, pathExists } from "./helpers.mjs";

test("strict JSON reads reject a symlink instead of following it", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const source = path.join(fixture.root, "outside.json");
  const linked = fixture.paths.protocol;
  await writeFile(source, '{"schema_version":1}\n');
  await symlink(source, linked);

  await assert.rejects(
    readJsonStrict(linked, value => value, fixture.paths.root),
    error => error.exitCode === EXIT.DATA,
  );
});

test("managed read APIs require an explicit absolute bus root", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  await writeFile(fixture.paths.protocol, '{}\n');

  await assert.rejects(
    readJsonStrict(fixture.paths.protocol, value => value),
    error => error.exitCode === EXIT.DATA,
  );
  await assert.rejects(
    listJsonFiles(fixture.paths.registry),
    error => error.exitCode === EXIT.DATA,
  );
});

test("strict JSON reads validate bytes from the no-follow handle they opened", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const target = fixture.paths.protocol;
  const replacement = path.join(fixture.root, "replacement.json");
  await writeFile(target, '{"value":1}\n');
  await writeFile(replacement, '{"value":2}\n');
  let swapped = false;

  const value = await readJsonStrict(target, record => record, fixture.paths.root,
    async (...args) => {
      const handle = await open(...args);
      await rename(replacement, target);
      swapped = true;
      return handle;
    });

  assert.equal(swapped, true);
  assert.deepEqual(value, { value: 1 });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { value: 2 });
});

test("strict reads reject a parent directory replaced while opening", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const target = fixture.paths.registryFile("visual");
  const retired = path.join(fixture.root, "retired-registry");
  const external = path.join(fixture.root, "external-registry-race");
  await writeFile(target, '{"source":"internal"}\n');
  await mkdir(external);
  await writeFile(path.join(external, "visual.json"), '{"source":"external"}\n');

  await assert.rejects(
    readJsonStrict(target, value => value, fixture.paths.root, async (...args) => {
      await rename(fixture.paths.registry, retired);
      await symlink(external, fixture.paths.registry);
      return open(...args);
    }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(external, "visual.json"), "utf8")),
    { source: "external" });
});

test("JSON listing rejects a directory replaced during enumeration", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const retired = path.join(fixture.root, "retired-inbox");
  const external = path.join(fixture.root, "external-inbox-race");
  await writeFile(path.join(fixture.paths.inbox, "internal.json"), '{}\n');
  await mkdir(external);
  const externalFile = path.join(external, "external.json");
  await writeFile(externalFile, '{"source":"external"}\n');

  await assert.rejects(
    listJsonFiles(fixture.paths.inbox, {
      root: fixture.paths.root,
      readDirectory: async (...args) => {
        await rename(fixture.paths.inbox, retired);
        await symlink(external, fixture.paths.inbox);
        return readdir(...args);
      },
    }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.deepEqual(JSON.parse(await readFile(externalFile, "utf8")),
    { source: "external" });
});

test("atomic publication rejects a symlinked destination directory", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const outside = await mkdtemp(path.join(os.tmpdir(), "pw2-agent-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(fixture.paths.inbox, { recursive: true });
  await symlink(outside, fixture.paths.inbox);
  const target = fixture.paths.inboxFile("models", "message-id");

  await assert.rejects(
    writeJsonAtomic(target, { value: 1 }, { tmpDir: fixture.paths.tmp, exclusive: true }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.equal(await pathExists(path.join(outside, "models", "message-id.json")), false);
});

test("atomic publication rejects destinations outside its managed bus", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const outside = path.join(fixture.root, "outside", "record.json");
  await mkdir(path.dirname(outside));

  await assert.rejects(
    writeJsonAtomic(outside, { value: 1 }, { tmpDir: fixture.paths.tmp, exclusive: true }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.equal(await pathExists(outside), false);
});

test("atomic moves reject a symlinked publication directory", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const outside = await mkdtemp(path.join(os.tmpdir(), "pw2-agent-move-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const source = path.join(fixture.paths.inbox, "message.json");
  await writeFile(source, '{"value":1}\n');
  await rm(fixture.paths.archive, { recursive: true });
  await symlink(outside, fixture.paths.archive);
  const destination = fixture.paths.archiveFile("models", "message-id");

  await assert.rejects(
    moveFileAtomic(source, destination, { root: fixture.paths.root }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.equal(await pathExists(source), true);
  assert.equal(await pathExists(path.join(outside, "models", "message-id.json")), false);
});

test("archive completion tolerates a disappeared source only with identical evidence", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const source = fixture.paths.inboxFile("models", "message-id");
  const destination = fixture.paths.archiveFile("models", "message-id");
  const expected = Buffer.from('{"value":1}\n');
  await mkdir(path.dirname(destination));
  await writeFile(destination, expected);

  await archiveFileNoReplace(source, destination, {
    root: fixture.paths.root,
    expectedBytes: expected,
  });

  assert.deepEqual(await readFile(destination), expected);
});

test("archive completion preserves a conflicting destination after source disappearance", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const source = fixture.paths.inboxFile("models", "message-id");
  const destination = fixture.paths.archiveFile("models", "message-id");
  const conflicting = Buffer.from('{"value":2}\n');
  await mkdir(path.dirname(destination));
  await writeFile(destination, conflicting);

  await assert.rejects(
    archiveFileNoReplace(source, destination, {
      root: fixture.paths.root,
      expectedBytes: Buffer.from('{"value":1}\n'),
    }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.deepEqual(await readFile(destination), conflicting);
});
