import assert from "node:assert/strict";
import test from "node:test";

import { ownerHeader } from "../src/owner-context.mjs";

const binding = { accSessionId: "session_a", generation: "generation_b" };

// The model appends the header to commands it runs in whatever shell its client
// gives it. On Windows that can be cmd.exe, which reads double quotes only.
test("windows: the directory is double-quoted, which cmd, PowerShell and Git Bash all read", () => {
  assert.equal(ownerHeader(binding, "C:\\Users\\First Last\\work\\acc", "acc://abc", "win32"),
    "ACC CLI (append): --session session_a --generation generation_b "
      + "--cwd \"C:\\Users\\First Last\\work\\acc\" --workspace \"acc://abc\"");
});

test("windows: a directory a double-quoting shell would expand keeps single quotes", () => {
  assert.equal(ownerHeader(binding, "C:\\work\\$budget", undefined, "win32"),
    "ACC CLI (append): --session session_a --generation generation_b --cwd 'C:\\work\\$budget'");
});

test("posix: single quotes, as before", () => {
  assert.equal(ownerHeader(binding, "/Users/ann/it's", undefined, "darwin"),
    "ACC CLI (append): --session session_a --generation generation_b --cwd '/Users/ann/it'\\''s'");
});
