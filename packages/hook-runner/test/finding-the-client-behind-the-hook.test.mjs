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

// Measured on macOS with Gemini CLI 0.60.0, a node script: every ancestor's
// comm is `node`. The launcher (46006) relaunches itself (46032) with a bigger
// heap, and the hook runs under the relaunched process.
const NODE = "/Users/u/.nvm/versions/node/v26.5.1/bin/node";
const GEMINI = "/Users/u/.nvm/versions/node/v26.5.1/bin/gemini";
const geminiTree = extra => new Map([
  [46006, { ppid: 1, comm: "node", args: `node ${GEMINI} -p hello --yolo` }],
  [46032, { ppid: 46006, comm: NODE,
    args: `${NODE} --max-old-space-size=65536 ${GEMINI} -p hello --yolo` }],
  [46100, { ppid: 46032, comm: "/bin/sh", args: "/bin/sh -c node acc-hook.mjs gemini_cli" }],
  [46101, { ppid: 46100, comm: "node", args: "node /data/acc/runtime/bin/acc-hook.mjs gemini_cli" }],
  ...extra ?? [],
]);

test("finds a client that is a node script by the script it runs, innermost first", () => {
  assert.equal(resolveClientPid({ table: geminiTree(), from: 46101, command: "gemini" }), 46032);
});

test("a script's own extension does not hide it", () => {
  const processes = new Map([
    [300, { ppid: 1, comm: "node",
      args: "node /opt/lib/node_modules/@google/gemini-cli/bundle/gemini.js -p hello" }],
    [301, { ppid: 300, comm: "node", args: "node hook.mjs" }]]);
  assert.equal(resolveClientPid({ table: processes, from: 301, command: "gemini" }), 300);
});

test("an interpreter whose path has spaces is skipped as a whole", () => {
  const processes = new Map([
    [300, { ppid: 1, comm: "/Applications/Dev Tools/node",
      args: "/Applications/Dev Tools/node /opt/bin/gemini -p hello" }],
    [301, { ppid: 300, comm: "node", args: "node hook.mjs" }]]);
  assert.equal(resolveClientPid({ table: processes, from: 301, command: "gemini" }), 300);
});

test("only the script a node process runs names it, not a later argument", () => {
  const processes = new Map([
    [300, { ppid: 1, comm: "node", args: "node /srv/server.js gemini" }],
    [301, { ppid: 300, comm: "node", args: "node hook.mjs" }]]);
  assert.equal(resolveClientPid({ table: processes, from: 301, command: "gemini" }), null);
});

for (const options of ["--require ./preload.cjs", "-r ./preload.cjs",
  "--import ./register.mjs --max-old-space-size=4096"]) {
  test(`an option's separate value does not hide the script: node ${options}`, () => {
    const processes = new Map([
      [300, { ppid: 1, comm: "node", args: `node ${options} /opt/bin/gemini -p hello` }],
      [301, { ppid: 300, comm: "node", args: "node hook.mjs" }]]);
    assert.equal(resolveClientPid({ table: processes, from: 301, command: "gemini" }), 300);
  });
}

test("an option with its value attached leaves the next word the script", () => {
  const processes = new Map([
    [300, { ppid: 1, comm: "node", args: "node --max-old-space-size=4096 /srv/server.js gemini" }],
    [301, { ppid: 300, comm: "node", args: "node hook.mjs" }]]);
  assert.equal(resolveClientPid({ table: processes, from: 301, command: "gemini" }), null);
});

test("past an option's value, the script's own arguments still do not name it", () => {
  const processes = new Map([
    [300, { ppid: 1, comm: "node", args: "node --require ./preload.cjs /srv/server.js gemini" }],
    [301, { ppid: 300, comm: "node", args: "node hook.mjs" }]]);
  assert.equal(resolveClientPid({ table: processes, from: 301, command: "gemini" }), null);
});

test("another interpreter's script is not matched", () => {
  const processes = new Map([
    [300, { ppid: 1, comm: "python3", args: "python3 /opt/gemini" }],
    [301, { ppid: 300, comm: "node", args: "node hook.mjs" }]]);
  assert.equal(resolveClientPid({ table: processes, from: 301, command: "gemini" }), null);
});

test("without arguments a node script client is not found, as before", () => {
  const withoutArgs = new Map([...geminiTree()].map(([pid, { args, ...entry }]) => [pid, entry]));
  assert.equal(resolveClientPid({ table: withoutArgs, from: 46101, command: "gemini" }), null);
});

// ps is asked twice at once: once for the tree, once for each command line.
const fakePs = ({ tree, args }) => async (file, argv, options) => {
  if (argv.join(" ").includes("args=")) {
    if (args instanceof Error) throw args;
    return { stdout: args, options };
  }
  return { stdout: tree, options };
};

test("reads each process's command line beside its parent and executable", async () => {
  const table = await readProcessTable({ run: fakePs({
    tree: `46006     1 node\n46032 46006 ${NODE}\n`,
    args: `46006 node ${GEMINI} -p hello\n`
      + `46032 ${NODE} --max-old-space-size=65536 ${GEMINI} -p "two words"\n` }) });

  assert.deepEqual(table.get(46006), { ppid: 1, comm: "node", args: `node ${GEMINI} -p hello` });
  assert.equal(table.get(46032).args, `${NODE} --max-old-space-size=65536 ${GEMINI} -p "two words"`);
});

test("a failed command-line read leaves the table as it was before", async () => {
  const table = await readProcessTable({ run: fakePs({
    tree: "  100     1 claude\n  200   100 node\n", args: new Error("ENOMEM") }) });

  assert.deepEqual(table.get(100), { ppid: 1, comm: "claude" });
  assert.deepEqual(table.get(200), { ppid: 100, comm: "node" });
});

test("both reads share the caller's timeout", async () => {
  const seen = [];
  await readProcessTable({ timeoutMs: 250, run: async (file, argv, options) => {
    seen.push({ args: argv.join(" ").includes("args="), timeout: options.timeout,
      maxBuffer: options.maxBuffer });
    return { stdout: "" };
  } });
  assert.deepEqual(seen.map(read => read.timeout), [250, 250]);
  // Command lines outgrow execFile's 1 MiB default long before the tree does.
  assert.ok(seen.find(read => read.args).maxBuffer > 1024 * 1024);
});

test("a platform without ps yields an empty table rather than an error", async () => {
  const table = await readProcessTable({ run: async () => { throw new Error("ENOENT"); } });
  assert.equal(table.size, 0);
});
