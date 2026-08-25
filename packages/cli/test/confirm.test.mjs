import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { askConfirmation } from "../src/confirm.mjs";

/**
 * The question `acc config init` asks.
 *
 * There was no port for it, so `runtime.confirm` fell back to a function that
 * always answered no: in a real terminal the command printed `not written` and
 * never said why. Proved with a pseudo-terminal, and fixed by making the asking
 * something a test can hold two streams up to.
 */
const ask = async answer => {
  const input = new PassThrough();
  const output = new PassThrough();
  const heard = [];
  output.on("data", chunk => heard.push(String(chunk)));

  const pending = askConfirmation("write ./acc.workspace.json?", { input, output });
  input.write(`${answer}\n`);
  return { agreed: await pending, said: heard.join("") };
};

test("the question is put to the reader, and yes means yes", async () => {
  const { agreed, said } = await ask("y");

  assert.equal(agreed, true);
  assert.match(said, /write \.\/acc\.workspace\.json\?/);
  assert.match(said, /\[y\/N\]/, "the reader is not told which answers count");
});

test("anything that is not yes is no", async () => {
  // A confirmation that reads a stray newline as agreement is not one. The
  // default has to be the answer that writes nothing.
  for (const [answer, expected] of [["y", true], ["Y", true], ["yes", true], ["YES", true],
    [" yes ", true], ["", false], ["n", false], ["no", false], ["yep", false],
    ["   ", false], ["ok", false]]) {
    assert.equal((await ask(answer)).agreed, expected, JSON.stringify(answer));
  }
});

test("a reader who closes the input has declined, not crashed", async () => {
  // Ctrl+D, or a pipe that ended. Verified against a real terminal, where it
  // used to come back as `Aborted with Ctrl+D` - an error report for somebody
  // deciding not to.
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = askConfirmation("write ./acc.workspace.json?", { input, output });
  input.end();

  assert.equal(await pending, false);
});

test("a build with no way to ask says so instead of answering for the reader", async t => {
  const { main } = await import("../src/main.mjs");
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;

  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-ask-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-ask-data-")));
  t.after(() => Promise.all([cwd, dataHome].map(dir => rm(dir, { recursive: true, force: true }))));

  const said = [];
  const stream = list => ({ isTTY: true, write: (text, done) => { list.push(text); done(); } });
  // No `confirm` port, and a terminal on the other end: the question would be
  // asked of nobody. It used to be answered "no" on the reader's behalf and
  // reported as `not written`, which reads like a decision they made.
  const code = await main(["config", "init", "--cwd", cwd],
    { cwd, env: { HOME: cwd, ACC_DATA_HOME: dataHome }, platform: process.platform,
      stdout: stream(said), stderr: stream(said),
      clock: { now: () => new Date().toISOString() }, ids: { next: kind => `${kind}_x` } });

  assert.notEqual(code, 0);
  assert.match(said.join(""), /without a way to ask/);
});

test("the binary hands the asking in", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  // The port is wired at the composition root, and nothing else here would
  // notice it being dropped: every test above supplies its own streams.
  const source = await readFile(
    fileURLToPath(new URL("../../../bin/acc.mjs", import.meta.url)), "utf8");

  assert.match(source, /confirm:/, "the CLI is built without a confirmation port");
  assert.match(source, /askConfirmation/);
});
