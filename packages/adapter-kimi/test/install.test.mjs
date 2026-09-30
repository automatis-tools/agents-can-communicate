import assert from "node:assert/strict";
import test from "node:test";

import { renderBlock } from "../src/install.mjs";

// Kimi Code runs a hook with Node's `shell: true`, which is cmd.exe on Windows.
// Quoting each path for TOML inside the command doubled every backslash that
// reached cmd; the command is now quoted for cmd and escaped for TOML once.
test("windows: the hook command reaches cmd with single backslashes", () => {
  const block = renderBlock("C:\\Users\\Ann\\AppData\\Local\\acc\\runtime\\bin\\acc-hook.mjs",
    "C:\\Program Files\\nodejs\\node.exe", "win32");
  const line = block.split("\n").find(text => text.startsWith("command = "));
  // A TOML basic string escapes like JSON for these characters.
  const command = JSON.parse(line.slice("command = ".length));
  assert.equal(command.startsWith("\"C:\\Program Files\\nodejs\\node.exe\" "
    + "\"C:\\Users\\Ann\\AppData\\Local\\acc\\runtime\\bin\\acc-hook.mjs\" kimi "), true, command);
});

test("posix: the command keeps its shell-quoted paths", () => {
  const block = renderBlock("/opt/acc/bin/acc-hook.mjs", "/usr/local/bin/node", "darwin");
  const line = block.split("\n").find(text => text.startsWith("command = "));
  assert.match(JSON.parse(line.slice("command = ".length)),
    /^"\/usr\/local\/bin\/node" "\/opt\/acc\/bin\/acc-hook\.mjs" kimi /);
});
