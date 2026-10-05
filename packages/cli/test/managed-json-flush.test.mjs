import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { flushesDuring } from "../../../tests/helpers/flush-recorder.mjs";

const { writeManagedJson } = await import("../src/managed-runtime/state.mjs");

// A managed record's name can be left to the flush after it when its loss on a
// crash is recovered by writing it again: the room a native session chose is
// chosen again by its next hook. Its bytes are always flushed, so a reader never
// finds a torn record.
test("a managed record can leave its name to the next flush, never its bytes", async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "acc-managed-flush-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "record.json");

  const full = await flushesDuring(() => writeManagedJson(file, { a: 1 }));
  const bytes = await flushesDuring(() => writeManagedJson(file, { a: 2 }, { flushName: false }));

  assert.equal(full.length, 2, `flushed ${JSON.stringify(full)}`);
  assert.equal(bytes.length, 1, `flushed ${JSON.stringify(bytes)}`);
  assert.match(path.basename(bytes[0]), /^\.record-.*\.tmp$/, "the flush was not of the bytes");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { a: 2 });
});
