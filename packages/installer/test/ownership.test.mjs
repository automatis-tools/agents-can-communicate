import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { fingerprint, loadOwnership, recordInstall, removeOwned, verifyOwned }
  from "../src/ownership.mjs";

async function place(t) {
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-own-")));
  const target = await realpath(await mkdtemp(path.join(tmpdir(), "acc-own-target-")));
  t.after(() => Promise.all([rm(dataHome, { recursive: true, force: true }),
    rm(target, { recursive: true, force: true })]));
  return { dataHome, target };
}

const write = async (file, body) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return file;
};

test("an install is recorded outside the project, under the data home", async t => {
  const { dataHome, target } = await place(t);
  const file = await write(path.join(target, "plugin", "hooks.json"), "{}\n");

  await recordInstall({ dataHome, adapterId: "codex", version: "0.0.0",
    artifacts: [{ path: file, kind: "file" }] });

  const record = await loadOwnership({ dataHome });
  assert.equal(record.installs.length, 1);
  assert.equal(record.installs[0].adapterId, "codex");
  // A repository is the wrong place for it: a clone would carry one machine's
  // installation state to another, where none of the paths exist.
  assert.equal(record.installs[0].artifacts[0].path.startsWith(target), true);
  assert.equal(path.relative(target, dataHome).startsWith(".."), true);
});

test("recording twice for one adapter replaces rather than accumulates", async t => {
  const { dataHome, target } = await place(t);
  const first = await write(path.join(target, "a.json"), "1\n");
  const second = await write(path.join(target, "b.json"), "2\n");

  await recordInstall({ dataHome, adapterId: "codex", version: "0.0.0",
    artifacts: [{ path: first, kind: "file" }] });
  await recordInstall({ dataHome, adapterId: "codex", version: "0.0.0",
    artifacts: [{ path: second, kind: "file" }] });

  const record = await loadOwnership({ dataHome });
  assert.equal(record.installs.length, 1, "a reinstall left a duplicate record");
  assert.deepEqual(record.installs[0].artifacts.map(a => a.path), [second]);
});

test("what was written is remembered by content, not just by name", async t => {
  const { dataHome, target } = await place(t);
  const file = await write(path.join(target, "hooks.json"), "{}\n");
  await recordInstall({ dataHome, adapterId: "codex", version: "0.0.0",
    artifacts: [{ path: file, kind: "file" }] });

  const clean = await verifyOwned({ dataHome, adapterId: "codex" });
  assert.deepEqual(clean.modified, []);
  assert.deepEqual(clean.missing, []);

  await writeFile(file, "{ \"edited\": true }\n");
  const edited = await verifyOwned({ dataHome, adapterId: "codex" });

  // Someone changed a file ACC wrote. That is theirs now, and the difference
  // has to be visible before anything is deleted.
  assert.deepEqual(edited.modified, [file]);
});

test("uninstall removes what still matches and leaves what does not", async t => {
  const { dataHome, target } = await place(t);
  const untouched = await write(path.join(target, "untouched.json"), "{}\n");
  const edited = await write(path.join(target, "edited.json"), "{}\n");
  await recordInstall({ dataHome, adapterId: "codex", version: "0.0.0",
    artifacts: [{ path: untouched, kind: "file" }, { path: edited, kind: "file" }] });
  await writeFile(edited, "mine now\n");

  const result = await removeOwned({ dataHome, adapterId: "codex" });

  assert.deepEqual(result.removed, [untouched]);
  assert.deepEqual(result.kept, [edited]);
  // Deleting an edited file would throw away work ACC did not do, on the
  // strength of a name it happens to recognise.
  assert.equal(await readFile(edited, "utf8"), "mine now\n");
});

test("a file already gone is not an error", async t => {
  const { dataHome, target } = await place(t);
  const file = await write(path.join(target, "gone.json"), "{}\n");
  await recordInstall({ dataHome, adapterId: "codex", version: "0.0.0",
    artifacts: [{ path: file, kind: "file" }] });
  await rm(file);

  const result = await removeOwned({ dataHome, adapterId: "codex" });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.missing, [file]);
});

test("uninstall forgets the adapter it removed, and only that one", async t => {
  const { dataHome, target } = await place(t);
  const mine = await write(path.join(target, "codex.json"), "{}\n");
  const theirs = await write(path.join(target, "kimi.json"), "{}\n");
  await recordInstall({ dataHome, adapterId: "codex", version: "0.0.0",
    artifacts: [{ path: mine, kind: "file" }] });
  await recordInstall({ dataHome, adapterId: "kimi", version: "0.0.0",
    artifacts: [{ path: theirs, kind: "file" }] });

  await removeOwned({ dataHome, adapterId: "codex" });

  const record = await loadOwnership({ dataHome });
  assert.deepEqual(record.installs.map(install => install.adapterId), ["kimi"]);
});

test("a merge artifact is never deleted, because ACC did not write the file", async t => {
  const { dataHome, target } = await place(t);
  const settings = await write(path.join(target, "settings.json"),
    '{"theme":"dark","hooks":{}}\n');
  await recordInstall({ dataHome, adapterId: "gemini_cli", version: "0.0.0",
    artifacts: [{ path: settings, kind: "merge" }] });

  const result = await removeOwned({ dataHome, adapterId: "gemini_cli" });

  // The user owns this file; ACC owns some entries inside it. Removing those is
  // the adapter's own uninstall, which knows the format.
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.delegated, [settings]);
  assert.equal(await readFile(settings, "utf8"), '{"theme":"dark","hooks":{}}\n');
});

test("no record at all is an empty answer, not a failure", async t => {
  const { dataHome } = await place(t);

  assert.deepEqual((await loadOwnership({ dataHome })).installs, []);
  assert.deepEqual((await verifyOwned({ dataHome, adapterId: "codex" })).missing, []);
  assert.deepEqual((await removeOwned({ dataHome, adapterId: "codex" })).removed, []);
});

test("a corrupt ownership record is refused rather than silently reset", async t => {
  const { dataHome } = await place(t);
  await write(path.join(dataHome, "acc", "installs.json"), "not json\n");

  // Treating it as empty would make the next uninstall a no-op and orphan every
  // file ACC has ever written on this machine.
  await assert.rejects(loadOwnership({ dataHome }), error => error.code === EXIT.DATA);
});

test("a fingerprint is stable for identical bytes and differs otherwise", async t => {
  const { target } = await place(t);
  const one = await write(path.join(target, "one"), "same\n");
  const two = await write(path.join(target, "two"), "same\n");
  const three = await write(path.join(target, "three"), "different\n");

  assert.equal(await fingerprint(one), await fingerprint(two));
  assert.notEqual(await fingerprint(one), await fingerprint(three));
  assert.equal(await fingerprint(path.join(target, "absent")), null);
});
