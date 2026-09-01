import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { listDirectoryEntries, listJsonFiles, publishAtomic, readJsonIfPresent }
  from "../src/atomic-json.mjs";
import { readRegularNoFollow } from "../src/safe-file.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-atomic-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tmpDir = path.join(root, "tmp");
  const records = path.join(root, "records");
  await mkdir(tmpDir);
  await mkdir(records);
  return { root, tmpDir, records, options: { root, tmpDir } };
}

const bytes = value => Buffer.from(`${value}\n`, "utf8");

test("immutable publication refuses to overwrite different bytes", async t => {
  const { records, options } = await fixture(t);
  const destination = path.join(records, "evidence.json");
  await publishAtomic(destination, bytes("original"), options);

  await assert.rejects(publishAtomic(destination, bytes("rewritten"), options),
    error => error.code === EXIT.CONFLICT);

  assert.equal(await readFile(destination, "utf8"), "original\n");
});

test("immutable publication treats identical bytes as already published", async t => {
  const { records, options } = await fixture(t);
  const destination = path.join(records, "evidence.json");
  await publishAtomic(destination, bytes("same"), options);

  // This is what makes journal roll-forward safe to run twice.
  assert.equal(await publishAtomic(destination, bytes("same"), options), "already_published");
  assert.equal(await readFile(destination, "utf8"), "same\n");
});

test("replace publication updates materialised state in place", async t => {
  const { records, options } = await fixture(t);
  const destination = path.join(records, "state.json");
  await publishAtomic(destination, bytes("first"), { ...options, replace: true });

  assert.equal(await publishAtomic(destination, bytes("second"), { ...options, replace: true }),
    "published");
  assert.equal(await readFile(destination, "utf8"), "second\n");
});

test("immutable publication retains temporary links rather than unlinking by path", async t => {
  const { tmpDir, records, options } = await fixture(t);
  const destination = path.join(records, "evidence.json");
  await publishAtomic(destination, bytes("original"), options);
  await assert.rejects(publishAtomic(destination, bytes("other"), options),
    error => error.code === EXIT.CONFLICT);

  const retained = await readdir(tmpDir);
  assert.equal(retained.length, 2);
  assert.deepEqual((await Promise.all(retained.map(file => readFile(path.join(tmpDir, file),
    "utf8")))).sort(), ["original\n", "other\n"]);
});

test("publication rejects a symlinked destination directory", async t => {
  const { root, records, options } = await fixture(t);
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "acc-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(records, { recursive: true });
  await symlink(outside, records);

  await assert.rejects(publishAtomic(path.join(records, "escaped.json"), bytes("x"), options),
    error => error.code === EXIT.DATA);

  assert.deepEqual(await readdir(outside), []);
  assert.equal(path.dirname(records), root);
});

test("publication rejects a destination outside the managed root", async t => {
  const { root, options } = await fixture(t);
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "acc-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));

  await assert.rejects(publishAtomic(path.join(outside, "escaped.json"), bytes("x"), options),
    error => error.code === EXIT.DATA);

  assert.deepEqual(await readdir(outside), []);
  assert.equal(typeof root, "string");
});

test("reads reject a symlink instead of following it", async t => {
  const { root, records } = await fixture(t);
  const backing = path.join(root, "backing.json");
  const linked = path.join(records, "linked.json");
  await writeFile(backing, bytes("secret"));
  await symlink(backing, linked);

  await assert.rejects(readRegularNoFollow(linked, root),
    error => error.code === EXIT.DATA);
});

test("reads reject a parent directory swapped while opening", async t => {
  const { root, records, options } = await fixture(t);
  const retired = path.join(root, "retired");
  const external = path.join(root, "external");
  await publishAtomic(path.join(records, "record.json"), bytes("internal"), options);
  await mkdir(external);
  await writeFile(path.join(external, "record.json"), bytes("external"));

  await assert.rejects(readRegularNoFollow(path.join(records, "record.json"), root,
    async (...args) => {
      await rename(records, retired);
      await symlink(external, records);
      const { open } = await import("node:fs/promises");
      return open(...args);
    }), error => error.code === EXIT.DATA);

  assert.equal(await readFile(path.join(external, "record.json"), "utf8"), "external\n");
});

test("listing rejects a directory replaced during enumeration", async t => {
  const { root, records } = await fixture(t);
  const retired = path.join(root, "retired");
  const external = path.join(root, "external");
  await mkdir(external);
  await writeFile(path.join(external, "external.json"), bytes("{}"));

  await assert.rejects(listDirectoryEntries(records, {
    root,
    readDirectory: async (...args) => {
      await rename(records, retired);
      await symlink(external, records);
      const { readdir: read } = await import("node:fs/promises");
      return read(...args);
    },
  }), error => error.code === EXIT.DATA);
});

test("listing a missing directory is empty rather than an error", async t => {
  const { root } = await fixture(t);
  assert.deepEqual(await listJsonFiles(path.join(root, "absent"), { root }), []);
});

test("reading a missing record is null rather than an error", async t => {
  const { root, records } = await fixture(t);
  assert.equal(await readJsonIfPresent(path.join(records, "absent.json"), root), null);
});

test("invalid JSON is a data error naming its file", async t => {
  const { root, records } = await fixture(t);
  const filePath = path.join(records, "broken.json");
  await writeFile(filePath, "{not-json");

  await assert.rejects(readJsonIfPresent(filePath, root),
    error => error.code === EXIT.DATA && error.details.filePath === filePath);
});
