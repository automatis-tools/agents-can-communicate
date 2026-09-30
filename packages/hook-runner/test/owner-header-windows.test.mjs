import assert from "node:assert/strict";
import test from "node:test";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { completeHookOutput } from "../../../bin/acc-hook.mjs";
import { ownerHeader } from "../src/owner-context.mjs";
import { runHook } from "../src/runner.mjs";

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
        && error.details.reasonCode === "workspace_path_unquotable"
        && /no quoting reads it alike in cmd, PowerShell and Git Bash/.test(error.message), cwd);
  }
  assert.equal(ownerHeader(binding, "C:\\Users\\o'brien", undefined, "win32"),
    "ACC CLI (append): --session session_a --generation generation_b --cwd \"C:\\Users\\o'brien\"");
});

// The hook fails open, and what the user reads is static advice chosen by the
// reason code: the refused path itself never reaches the client.
test("a refused header tells the user what to rename, without the path", async () => {
  const adapter = { id: "fixture", client: { command: null }, capabilities: {},
    normalizeHook: () => {
      throw new AccError(EXIT.USAGE, "C:\\it's\\$x cannot be quoted",
        { value: "C:\\it's\\$x", reasonCode: "workspace_path_unquotable" });
    } };
  const result = await runHook({ adapterId: adapter.id, adapters: { [adapter.id]: adapter },
    dataHome: "/nonexistent", payload: {} });
  assert.equal(result.failureCode, "workspace_path_unquotable");

  const written = [];
  await completeHookOutput(result, {
    stdout: { write(output, callback) { written.push(["stdout", output]); callback?.(); } },
    stderr: { write(output, callback) { written.push(["stderr", output]); callback?.(); } },
  });
  const stderr = written.filter(([stream]) => stream === "stderr").map(([, text]) => text).join("");
  assert.match(stderr, /mixes quotes, \$, `, % or a cmd operator/);
  assert.match(stderr, /rename it and restart the client/);
  assert.equal(stderr.includes("it's"), false, "the hook reflected the path");
});

// PowerShell takes U+2018 to U+201B as single quotes and U+201C to U+201E as
// double quotes, and NTFS allows every one of them in a directory name: `x”;calc;”`
// in double quotes ends the string at `”` and runs `calc`. cmd reads no single
// quotes at all, so a single-quoted value must not carry what cmd acts on.
test("windows: typographic quotes and cmd's operators get no header either", () => {
  for (const cwd of ["C:\\w\\it\u2019s\\$(calc)", "C:\\w\\x\u201c\u2018", "C:\\w\\a$b&calc",
    "C:\\w\\a$b|calc", "C:\\w\\a$b^x", "C:\\w\\100%"]) {
    assert.throws(() => ownerHeader(binding, cwd, undefined, "win32"),
      error => error.details?.reasonCode === "workspace_path_unquotable", cwd);
  }
  assert.equal(ownerHeader(binding, "C:\\w\\it\u2019s", undefined, "win32"),
    "ACC CLI (append): --session session_a --generation generation_b --cwd \"C:\\w\\it\u2019s\"");
  // A typographic double quote keeps the string single-quoted, which every one
  // of them reads literally.
  assert.equal(ownerHeader(binding, "C:\\w\\x\u201d;calc;\u201d", undefined, "win32"),
    "ACC CLI (append): --session session_a --generation generation_b --cwd 'C:\\w\\x\u201d;calc;\u201d'");
  assert.equal(ownerHeader(binding, "C:\\w\\a&b", undefined, "win32"),
    "ACC CLI (append): --session session_a --generation generation_b --cwd \"C:\\w\\a&b\"");
});
