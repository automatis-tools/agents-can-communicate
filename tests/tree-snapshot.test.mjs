import assert from "node:assert/strict";
import test from "node:test";

import { snapshotDifferences } from "../scripts/tree-snapshot.mjs";

// Issue #442. A restoration check that only says "did not restore" leaves an
// intermittent failure with nothing to read. Each difference names its path,
// its type and what changed, without dumping file bytes.
test("snapshot differences name each added, removed and changed entry", () => {
  const before = [
    { path: "a", type: "directory", mode: 0o755 },
    { path: "a/kept.txt", type: "file", mode: 0o644, bytes: "eA==" },
    { path: "a/gone.txt", type: "file", mode: 0o644, bytes: "eA==" },
    { path: "a/bytes.txt", type: "file", mode: 0o644, bytes: "eA==" },
    { path: "a/mode.txt", type: "file", mode: 0o644, bytes: "eA==" },
    { path: "a/link", type: "symlink", mode: 0o755, target: "one" },
  ];
  const after = [
    { path: "a", type: "directory", mode: 0o755 },
    { path: "a/kept.txt", type: "file", mode: 0o644, bytes: "eA==" },
    { path: "a/bytes.txt", type: "file", mode: 0o644, bytes: "eQ==" },
    { path: "a/mode.txt", type: "file", mode: 0o600, bytes: "eA==" },
    { path: "a/link", type: "symlink", mode: 0o755, target: "two" },
    { path: "a/new", type: "directory", mode: 0o700 },
  ];
  assert.deepEqual(snapshotDifferences(before, after), [
    "changed file a/bytes.txt: bytes",
    "removed file a/gone.txt",
    "changed symlink a/link: target",
    "changed file a/mode.txt: mode 644 -> 600",
    "added directory a/new",
  ]);
});

test("identical snapshots have no differences", () => {
  const snapshot = [{ path: "x", type: "file", mode: 0o644, bytes: "" }];
  assert.deepEqual(snapshotDifferences(snapshot, structuredClone(snapshot)), []);
});

test("an entry that changed its type is reported with both types", () => {
  assert.deepEqual(snapshotDifferences([{ path: "x", type: "file", mode: 0o644, bytes: "" }],
    [{ path: "x", type: "directory", mode: 0o755 }]), ["changed x: file -> directory"]);
});
