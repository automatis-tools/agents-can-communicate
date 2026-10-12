import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { installClaudePlugin } from "../src/install.mjs";

const ready = { health: "ready", reception: "automatic", reasonCode: null, label: "ACC ●",
  detail: "This chat can receive addressed requests without another user prompt." };
// What Claude's $.process.run does with a child that is still running at its
// timeout (measured on 2.1.296): it rejects once the timeout has passed.
const timedOut = { reject: "timeout" };
// A child that cannot start rejects at once.
const unstarted = { reject: "start" };

/** The installed indicator module with a scripted Claude host. Each read takes
 * the next outcome: a report object, `timedOut` or `unstarted`. */
async function indicator(t, outcomes) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-indicator-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await installClaudePlugin({ configDir: root, clientVersion: "2.1.295", indicator: "on" });
  const file = path.join(root, "plugins", "marketplaces", "acc-local", "agents-can-communicate", "hooks", "indicator.mjs");
  const module = await import(pathToFileURL(file).href);
  const handlers = new Map();
  module.register((event, matcher, handler) => handlers.set(event,
    typeof matcher === "function" ? matcher : handler));
  const host = { now: 10_000, logs: [], reads: [], tick: null };
  const $ = { session: { id: async () => "refresh-fixture" },
    clock: { now: async () => host.now, every: (_ms, fn) => { host.tick = fn; } },
    command: { register: async () => {} },
    process: { run: async (_argv, init) => {
      host.reads.push(init);
      const next = outcomes.shift();
      assert.ok(next, "the test scripted every read");
      if (next.reject === "timeout") {
        host.now += init.timeoutMs + 50;
        throw new Error(`$.process.run aborted: still running after ${init.timeoutMs}ms`);
      }
      if (next.reject === "start") throw new Error("$.process.run could not start");
      return { exitCode: 0, stdout: JSON.stringify(next), stderr: "" };
    } },
    ui: { log: async text => { host.logs.push(text); }, invalidate: () => {}, resolve: () => ({
      Box: props => ({ type: "Box", ...props }), Text: props => ({ type: "Text", ...props }),
    }) } };
  await handlers.get("session.start")($, {}, async e => e);
  return {
    host,
    // The next steady refresh, five seconds after the previous one.
    async refresh() { host.now += 5_000; await host.tick(); },
    // The footer text the module draws after the native one.
    async shown() {
      const tree = await handlers.get("ui.render")($, { props: { modes: [] } }, async () => null);
      return tree.children.slice(1).map(node => node.children.join("")).join("").trim();
    },
  };
}

test("a read that Claude stops waiting for between healthy reads keeps the badge and the transcript quiet", async t => {
  const view = await indicator(t, [ready, timedOut, ready, timedOut, ready, timedOut, ready]);
  for (let i = 0; i < 6; i++) {
    await view.refresh();
    assert.equal(await view.shown(), "ACC ●", `refresh ${i + 1} keeps the last healthy state`);
  }
  assert.deepEqual(view.host.logs, [], "an isolated failed read is not a new problem of this chat");
});

test("reads that keep failing show the problem and print it once", async t => {
  const view = await indicator(t, [ready, timedOut, timedOut, timedOut, timedOut, timedOut]);
  await view.refresh();
  await view.refresh();
  assert.equal(await view.shown(), "ACC ●", "two failed reads in a row are still treated as transient");
  await view.refresh();
  assert.equal(await view.shown(), "ACC !", "the third failed read in a row is shown");
  await view.refresh();
  await view.refresh();
  assert.equal(view.host.logs.length, 1, "the unchanged problem is printed once");
  assert.match(view.host.logs[0], /did not answer within five seconds/);
  assert.doesNotMatch(view.host.logs[0], /acc install/,
    "reinstalling cannot make a slow read faster");
});

test("an indicator that cannot start keeps the repair command", async t => {
  const view = await indicator(t, [ready, unstarted, unstarted, unstarted]);
  for (let i = 0; i < 3; i++) await view.refresh();
  assert.equal(await view.shown(), "ACC !");
  assert.equal(view.host.logs.length, 1);
  assert.match(view.host.logs[0], /could not read this session's state/);
  assert.match(view.host.logs[0], /acc install --adapter claude_code --indicator on/);
});

test("a single failed read reported by the reader itself is transient too", async t => {
  const unavailable = { health: "problem", reasonCode: "indicator_unavailable", label: "ACC !",
    detail: "ACC's installed indicator is unavailable." };
  const view = await indicator(t, [ready, unavailable, ready]);
  await view.refresh();
  assert.equal(await view.shown(), "ACC ●", "a concurrent update can cause one failed read");
  await view.refresh();
  assert.equal(await view.shown(), "ACC ●");
  assert.deepEqual(view.host.logs, []);
});

test("a failed first read leaves the startup state", async t => {
  const view = await indicator(t, [timedOut, ready]);
  assert.equal(await view.shown(), "ACC …");
  assert.deepEqual(view.host.logs, []);
  await view.refresh();
  assert.equal(await view.shown(), "ACC ●");
});

test("Claude waits for the reader longer than the reader waits for ACC state", async t => {
  const view = await indicator(t, [ready]);
  // acc-indicator answers at the latest 1.5 s after its modules load. Inside a
  // loaded Claude 2.1.296 the child's start alone took up to 1.3 s (108 reads,
  // 2026-10-12), so a bound below both kills reads that would have answered.
  assert.ok(view.host.reads[0].timeoutMs >= 1_500 + 1_300,
    `timeout ${view.host.reads[0].timeoutMs} ms must cover the reader's start and deadline`);
});
