import assert from "node:assert/strict";
import test from "node:test";

import { windowsHookCommand } from "../src/windows-command.mjs";

// A Windows profile path carries a space and, now and then, an apostrophe.
const node = "C:\\Program Files\\nodejs\\node.exe";
const shim = "C:\\Users\\Ann O'Neil\\.codex\\acc\\acc-hook.mjs";

test("PowerShell: the call operator on single-quoted literals, and the hook's own exit code", () => {
  // Codex runs hooks through `pwsh -Command`, which turns exit 2 into 1 unless
  // the command exits with $LASTEXITCODE itself (openai/codex#48183).
  assert.equal(windowsHookCommand("powershell", { node, shim, args: ["sessionStart"] }),
    "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Ann O''Neil\\.codex\\acc\\acc-hook.mjs' "
      + "sessionStart; exit $LASTEXITCODE");
});

test("portable: node from PATH on a double-quoted forward-slash path, valid in PowerShell, Git Bash and cmd", () => {
  assert.equal(windowsHookCommand("portable", { node, shim, args: ["guard"] }),
    "node \"C:/Users/Ann O'Neil/.codex/acc/acc-hook.mjs\" guard");
});

test("cmd: the pinned node and the shim in double quotes", () => {
  assert.equal(windowsHookCommand("cmd", { node, shim, args: ["kimi", "beforeTurn"] }),
    "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\Ann O'Neil\\.codex\\acc\\acc-hook.mjs\" kimi beforeTurn");
});

test("unquoted: for a runner that escapes quotes cmd cannot read, a path with no space only", () => {
  assert.equal(windowsHookCommand("unquoted", { node, shim: "C:\\Users\\ANNONE~1\\acc\\acc-hook.mjs",
    args: ["Stop"] }), "node C:/Users/ANNONE~1/acc/acc-hook.mjs Stop");
  assert.throws(() => windowsHookCommand("unquoted", { node, shim, args: ["Stop"] }), /space/);
});

test("a path a shell would expand is refused rather than written", () => {
  for (const bad of ["C:\\Users\\$env\\x.mjs", "C:\\Users\\a`b\\x.mjs", "C:\\Users\\a\"b\\x.mjs",
    "C:\\Users\\%USERNAME%\\x.mjs"]) {
    assert.throws(() => windowsHookCommand("portable", { node, shim: bad, args: ["x"] }), /cannot/, bad);
  }
});

test("a path with a space is asked for its 8.3 name through cmd's %~s", async () => {
  const { shortPath } = await import("../src/windows-command.mjs");
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: "C:\\Users\\ANNONE~1\\.gemini\\config\\acc\\acc-hook.mjs\r\n" };
  };
  assert.equal(await shortPath("C:\\Users\\Ann O'Neil\\.gemini\\config\\acc\\acc-hook.mjs",
    { run, env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } }),
  "C:\\Users\\ANNONE~1\\.gemini\\config\\acc\\acc-hook.mjs");
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(await shortPath("C:\\NoSpace\\x.mjs", { run: async () => { throw new Error("unused"); } }),
    "C:\\NoSpace\\x.mjs");
});

// Antigravity's runner cannot pass a quoted path, so the path reaches cmd bare:
// `node C:/Users/Ann/A&calc&B/...` runs calc, and , ; = split the word the way a
// space does. A path with none of these has nothing cmd acts on.
test("an unquoted command refuses what cmd acts on outside quotes", () => {
  for (const shim of ["C:\\Users\\Ann\\A&calc&B\\acc-hook.mjs", "C:\\a|b\\acc-hook.mjs",
    "C:\\a<b\\acc-hook.mjs", "C:\\a>b\\acc-hook.mjs", "C:\\a^b\\acc-hook.mjs",
    "C:\\a(b)\\acc-hook.mjs", "C:\\a,b\\acc-hook.mjs", "C:\\a;b\\acc-hook.mjs",
    "C:\\a=b\\acc-hook.mjs", "C:\\a!b\\acc-hook.mjs"]) {
    assert.throws(() => windowsHookCommand("unquoted", { node: "node", shim, args: ["start"] }),
      /cannot name .* unquoted/, shim);
  }
  assert.equal(windowsHookCommand("unquoted", { node: "node",
    shim: "C:\\Users\\O'Neil\\PROGRA~1\\acc-hook.mjs", args: ["start"] }),
  "node C:/Users/O'Neil/PROGRA~1/acc-hook.mjs start");
});
