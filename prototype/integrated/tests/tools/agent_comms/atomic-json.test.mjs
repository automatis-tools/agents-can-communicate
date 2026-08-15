import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  listJsonFiles,
  moveFileAtomic,
  readJsonStrict,
  writeJsonAtomic,
} from "../../../tools/agents/lib/atomic-json.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { createBusFixture, pathExists } from "./helpers.mjs";

test("exclusive writes never replace an immutable record", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const target = path.join(fixture.paths.inbox, "models", "message.json");
  await writeJsonAtomic(target, { value: 1 }, {
    tmpDir: fixture.paths.tmp,
    exclusive: true,
  });

  await assert.rejects(
    writeJsonAtomic(target, { value: 2 }, {
      tmpDir: fixture.paths.tmp,
      exclusive: true,
    }),
    error => error.exitCode === EXIT.CONFLICT,
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { value: 1 });
  assert.deepEqual(await listJsonFiles(fixture.paths.tmp, { root: fixture.paths.root }), []);
});

test("mutable writes atomically replace the published value", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const target = fixture.paths.presenceFile("visual");
  await writeJsonAtomic(target, { heartbeat: 1 }, {
    tmpDir: fixture.paths.tmp,
    exclusive: false,
  });
  await writeJsonAtomic(target, { heartbeat: 2 }, {
    tmpDir: fixture.paths.tmp,
    exclusive: false,
  });

  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { heartbeat: 2 });
});

test("values are serialized exactly once before publication", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  let serializations = 0;
  const value = {
    toJSON() {
      serializations += 1;
      return { serializations };
    },
  };

  await writeJsonAtomic(fixture.paths.protocol, value, {
    tmpDir: fixture.paths.tmp,
    exclusive: true,
  });

  assert.equal(serializations, 1);
  assert.deepEqual(JSON.parse(await readFile(fixture.paths.protocol, "utf8")), {
    serializations: 1,
  });
});

test("malformed JSON fails the corrupt-data gate", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const target = path.join(fixture.paths.inbox, "broken.json");
  await writeFile(target, "{not-json", "utf8");

  await assert.rejects(
    readJsonStrict(target, value => value, fixture.paths.root),
    error => error.exitCode === EXIT.DATA && error.details.filePath === target,
  );
});

test("strict reads return the original validated value", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const target = fixture.paths.protocol;
  await writeFile(target, '{"schema_version":1}\n', "utf8");
  let parsed;

  const result = await readJsonStrict(target, value => {
    parsed = value;
    return value;
  }, fixture.paths.root);

  assert.equal(result, parsed);
});

test("JSON listings include only regular JSON files in lexical order", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const directory = fixture.paths.handoffs;
  await writeFile(path.join(directory, "b.json"), "{}", "utf8");
  await writeFile(path.join(directory, "ignore.txt"), "{}", "utf8");
  await writeFile(path.join(directory, "a.json"), "{}", "utf8");
  await mkdir(path.join(directory, "directory.json"));

  assert.deepEqual(await listJsonFiles(directory, { root: fixture.paths.root }), [
    path.join(directory, "a.json"),
    path.join(directory, "b.json"),
  ]);
  assert.deepEqual(await listJsonFiles(fixture.paths.inboxDir("missing"), {
    root: fixture.paths.root,
  }), []);
});

test("atomic moves create the destination directory and remove the source", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const source = path.join(fixture.paths.inbox, "message.json");
  const destination = fixture.paths.archiveFile("models", "message");
  await writeFile(source, '{"value":1}\n', "utf8");

  await moveFileAtomic(source, destination, { root: fixture.paths.root });

  assert.equal(await pathExists(source), false);
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), { value: 1 });
});
