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

// Inside single quotes sh reads '\'' as a quote and PowerShell reads '', so the
// sh spelling of `o'brien\$(calc)` leaves `$(calc)` bare to PowerShell, which
// runs it. With a single quote and a character that double quotes expand, no
// spelling reads the same in sh, PowerShell and cmd, and the header is refused
// by name rather than handed to the model.
test("windows: a directory with a single quote and $, ` or % has no header", () => {
  for (const cwd of ["C:\\Users\\o'brien\\$(calc)", "C:\\it's\\`n", "C:\\it's\\100%"]) {
    assert.throws(() => ownerHeader(binding, cwd, "acc://abc", "win32"),
      error => error.code === 2 && error.details.value === cwd
        && /no quoting that every Windows shell reads the same/.test(error.message), cwd);
  }
  assert.equal(ownerHeader(binding, "C:\\Users\\o'brien", undefined, "win32"),
    "ACC CLI (append): --session session_a --generation generation_b --cwd \"C:\\Users\\o'brien\"");
});
