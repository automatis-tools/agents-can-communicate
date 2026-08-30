import assert from "node:assert/strict";
import test from "node:test";

import { resolveClientPid } from "../src/client-pid.mjs";
import { readProcessTable } from "../src/process-table.mjs";

// pid -> parent and executable, the shape `ps -o pid=,ppid=,comm=` gives us.
const table = entries => new Map(entries.map(([pid, ppid, comm]) => [pid, { ppid, comm }]));

test("finds the client when the hook is its direct child", () => {
  const processes = table([[100, 1, "claude"], [200, 100, "node"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "claude" }), 100);
});

test("finds the client through an intervening shell", () => {
  // Measured on a real machine: a hook's parent is /bin/zsh and the client is
  // its grandparent, so stopping at the parent would record a process that dies
  // with the hook.
  const processes = table([[100, 1, "claude"], [150, 100, "/bin/zsh"], [200, 150, "node"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "claude" }), 100);
});

test("matches on the basename, since ps reports some entries with a path", () => {
  const processes = table([[100, 1, "/usr/local/bin/kimi"], [200, 100, "node"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "kimi" }), 100);
});

test("returns null when no ancestor is the client", () => {
  const processes = table([[100, 1, "sshd"], [200, 100, "node"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "claude" }), null);
});

test("returns null on an empty table", () => {
  assert.equal(resolveClientPid({ table: new Map(), from: 200, command: "claude" }), null);
});

test("gives up rather than looping on a cyclic table", () => {
  // A pid table read while processes are exiting can disagree with itself.
  const processes = table([[100, 200, "a"], [200, 100, "b"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "claude" }), null);
});

test("stops after the hop limit", () => {
  const deep = table(Array.from({ length: 40 },
    (unused, index) => [index + 1, index + 2, "sh"])
    .concat([[41, 1, "claude"]]));
  assert.equal(resolveClientPid({ table: deep, from: 1, command: "claude", maxHops: 5 }), null);
});

test("parses a ps table, including commands containing spaces", async () => {
  const stdout = "  100     1 claude\n  150   100 /bin/zsh\n"
    + "  200   150 /Applications/Some App.app/Contents/MacOS/app\n";
  const table = await readProcessTable({ run: async () => ({ stdout }) });

  assert.equal(table.get(100).comm, "claude");
  assert.equal(table.get(150).ppid, 100);
  assert.equal(table.get(200).comm, "/Applications/Some App.app/Contents/MacOS/app");
});

test("a platform without ps yields an empty table rather than an error", async () => {
  const table = await readProcessTable({ run: async () => { throw new Error("ENOENT"); } });
  assert.equal(table.size, 0);
});
