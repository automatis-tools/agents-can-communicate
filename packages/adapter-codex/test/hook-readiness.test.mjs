import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeTest from "node:test";

import { createCodexAdapter } from "../src/adapter.mjs";
import { createCodexDiscovery } from "../src/native-discovery.mjs";
import { maintenanceFixture } from "./maintenance-fixture.mjs";
import { posixTransportTest } from "../../../tests/helpers/platform-scope.mjs";

// #427: doctor asked for a hook review on every run, even while Codex ran all
// of ACC's hooks. It now takes Codex's own answer from a verified daemon, and
// keeps the review whenever that answer is missing or names a hook that would
// not run.
const PLUGIN = "agents-can-communicate-hooks@acc-local";
const EVENTS = ["preToolUse", "sessionStart", "sessionEnd", "userPromptSubmit", "stop"];
const accHooks = (overrides = {}) => EVENTS.map(eventName => ({
  key: `${PLUGIN}:hooks.json:${eventName}:0:0`, eventName, handlerType: "command", source: "plugin",
  pluginId: PLUGIN, enabled: true, isManaged: false, trustStatus: "trusted",
  ...(overrides[eventName] ?? {}) }));

async function installed(t, readHookReadiness) {
  const home = await mkdtemp(path.join(tmpdir(), "acc-readiness-"));
  const stateRoot = await mkdtemp(path.join(tmpdir(), "acc-readiness-state-"));
  t.after(() => Promise.all([home, stateRoot].map(one => rm(one, { recursive: true, force: true }))));
  const calls = [];
  const adapter = createCodexAdapter({ discovery: { discoverNativeSessions: async () => [],
    readHookReadiness: async request => { calls.push(request); return readHookReadiness(request); } } });
  const context = { home, stateRoot, env: { HOME: home } };
  await adapter.install(context);
  return { adapter, context, calls };
}
const runs = events => events.map(eventName => ({ eventName, state: "runs" }));

nodeTest("hooks Codex reports enabled and trusted need no review", async t => {
  const { adapter, context, calls } = await installed(t, ({ events }) => runs(events));
  const detected = await adapter.detect(context);
  assert.equal(detected.needsAction.some(line => /\/hooks/.test(line)), false, JSON.stringify(detected.needsAction));
  assert.match(detected.diagnostics.join("\n"), /Codex reports ACC's hooks enabled and trusted: (?:\w+, ){4}\w+$/m);
  // The events ACC installed, asked of the Codex home this detection reads.
  assert.deepEqual(calls[0].events.toSorted(), EVENTS.toSorted());
  assert.equal(calls[0].env.CODEX_HOME, path.join(context.home, ".codex"));
  assert.match((await adapter.doctor(context)).diagnostics.join("\n"), /enabled and trusted/);
});

nodeTest("a hook Codex would not run is named, and the review stays", async t => {
  const { adapter, context } = await installed(t, ({ events }) => events.map(eventName => ({ eventName,
    state: eventName === "sessionStart" ? "modified" : eventName === "stop" ? "disabled" : "runs" })));
  const review = (await adapter.detect(context)).needsAction.find(line => /\/hooks/.test(line));
  assert.ok(review);
  assert.match(review, /^Codex will not run these ACC hooks: sessionStart \(modified\), stop \(disabled\);/);
  assert.match(review, /trust/);
});

nodeTest("without Codex's answer the review stays unverified", async t => {
  for (const answer of [() => null, () => { throw new Error("no daemon"); }, () => [{ eventName: "stop", state: "runs" }]]) {
    const { adapter, context } = await installed(t, answer);
    const detected = await adapter.detect(context);
    assert.ok(detected.needsAction.some(line => /^hook readiness unverified: open codex/.test(line)));
    assert.match(detected.diagnostics.join("\n"), /hook readiness is unverified by ACC/);
  }
});

nodeTest("an unreadable hooks file asks Codex nothing and keeps the review", async t => {
  const { adapter, context, calls } = await installed(t, ({ events }) => runs(events));
  const file = path.join(context.home, ".agents", "acc-local", "plugins",
    "agents-can-communicate-hooks", "hooks.json");
  await readFile(file);
  await writeFile(file, "{ not json");
  const detected = await adapter.detect(context);
  assert.equal(calls.length, 0);
  assert.ok(detected.needsAction.some(line => /^hook readiness unverified/.test(line)));
});

async function daemon(t) {
  const f = await maintenanceFixture(t);
  const { readHookReadiness } = createCodexDiscovery({ run: f.run, open: f.open });
  const read = (extra = {}) => readHookReadiness({ env: f.context.env, home: f.context.home,
    cwd: f.context.home, events: EVENTS, ...extra });
  return { f, read };
}

posixTransportTest("the verified daemon's hooks/list decides each hook", async t => {
  const { f, read } = await daemon(t);
  f.state.hooks = { [f.context.home]: accHooks() };
  assert.deepEqual(await read(), runs(EVENTS));
  assert.deepEqual(f.requests.find(request => request.method === "hooks/list").params, { cwds: [f.context.home] });
  f.state.hooks = { [f.context.home]: [...accHooks({ sessionStart: { trustStatus: "untrusted" },
    sessionEnd: { trustStatus: "managed" }, stop: { enabled: false } }).filter(hook => hook.eventName !== "preToolUse"),
  { ...accHooks()[0], pluginId: "someone-else@market" }] };
  assert.deepEqual(await read(), [{ eventName: "preToolUse", state: "not listed" },
    { eventName: "sessionStart", state: "untrusted" }, { eventName: "sessionEnd", state: "runs" },
    { eventName: "userPromptSubmit", state: "runs" }, { eventName: "stop", state: "disabled" }]);
});

posixTransportTest("no daemon, an unproven one or a failed list is no answer", async t => {
  const { f, read } = await daemon(t);
  f.state.hooks = { [f.context.home]: accHooks() };
  f.state.hooksError = new Error("hooks/list unavailable");
  assert.equal(await read(), null);
  delete f.state.hooksError;
  f.state.processUnknown = true;
  assert.equal(await read(), null);
  f.state.processUnknown = false;
  f.state.socketOwned = false;
  assert.equal(await read(), null);
  f.state.socketOwned = true;
  await f.stop();
  assert.equal(await read(), null);
  assert.equal(f.commands.includes("start"), false, "reading readiness started a service");
});
