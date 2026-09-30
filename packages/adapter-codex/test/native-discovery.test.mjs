import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import nodeTest from "node:test";

import { createCodexDiscovery } from "../src/native-discovery.mjs";
import { maintenanceFixture } from "./maintenance-fixture.mjs";
import { posixTransportTest as test } from "../../../tests/helpers/platform-scope.mjs";

const PLUGIN = "agents-can-communicate@acc-local";
// What `hooks/list` returns for ACC's plugin on 0.158.0, one entry per event.
const accHooks = (overrides = {}) => ["preToolUse", "sessionStart", "sessionEnd", "userPromptSubmit",
  "stop"].map(eventName => ({ key: `${PLUGIN}:hooks.json:${eventName}:0:0`, eventName,
  handlerType: "command", source: "plugin", pluginId: PLUGIN, enabled: true, isManaged: false,
  trustStatus: "trusted", ...(overrides[eventName] ?? {}) }));

async function discovery(t) {
  const f = await maintenanceFixture(t);
  const project = path.join(f.root, "project");
  await mkdir(project);
  const thread = (id, extra = {}) => ({ id, cwd: project, parentThreadId: null, ephemeral: false,
    status: { type: "idle" }, ...extra });
  f.state.threads = [thread("thread-empty")];
  f.state.hooks = { [project]: accHooks() };
  const { discoverNativeSessions } = createCodexDiscovery({ run: f.run, open: f.open });
  const discover = () => discoverNativeSessions({ env: f.context.env, home: f.context.home });
  return { f, project, thread, discover };
}

test("an idle chat whose directory runs ACC's hooks is a candidate on the verified daemon", async t => {
  const { f, project, discover } = await discovery(t);
  assert.deepEqual(await discover(), [{ sessionId: "thread-empty", cwd: project,
    clientPid: f.state.pid, clientVersion: f.state.serverVersion }]);
  const reads = f.requests.filter(request => request.method === "thread/read");
  assert.ok(reads.length > 0 && reads.every(request => request.params.includeTurns === false));
  assert.deepEqual(f.requests.find(request => request.method === "hooks/list").params,
    { cwds: [project] });
});

test("subagents, ephemeral and busy threads are never candidates", async t => {
  const { f, thread, discover } = await discovery(t);
  f.state.threads = [thread("subagent", { parentThreadId: "thread-empty" }),
    thread("ephemeral", { ephemeral: true }), thread("busy", { status: { type: "active" } }),
    thread("unloaded", { status: { type: "notLoaded" } })];
  assert.deepEqual(await discover(), []);
});

test("a chat whose directory would not run ACC's hooks is not a candidate", async t => {
  const { f, project, discover } = await discovery(t);
  for (const hooks of [[], accHooks({ sessionStart: { trustStatus: "untrusted" } }),
    accHooks({ sessionEnd: { trustStatus: "modified" } }),
    accHooks({ userPromptSubmit: { enabled: false } }),
    accHooks().filter(hook => hook.eventName !== "sessionEnd"),
    accHooks().map(hook => ({ ...hook, pluginId: "someone-else@market" }))]) {
    f.state.hooks = { [project]: hooks };
    assert.deepEqual(await discover(), [], JSON.stringify(hooks.map(h => [h.eventName, h.trustStatus])));
  }
  f.state.hooks = { [project]: accHooks({ sessionStart: { trustStatus: "managed" },
    sessionEnd: { trustStatus: "managed" }, userPromptSubmit: { trustStatus: "managed" } }) };
  assert.equal((await discover()).length, 1, "managed hooks run as trusted ones do");
});

test("nothing is found without a daemon whose process and socket are proven", async t => {
  const { f, discover } = await discovery(t);
  f.state.socketOwned = false;
  assert.deepEqual(await discover(), [], "the pid does not hold the control socket");
  f.state.socketOwned = true;
  f.state.processUnknown = true;
  assert.deepEqual(await discover(), [], "the process cannot be inspected");
  f.state.processUnknown = false;
  f.state.hooksError = new Error("hooks/list unavailable");
  assert.deepEqual(await discover(), [], "hook readiness cannot be read");
  f.state.hooksError = null;
  await f.stop();
  assert.deepEqual(await discover(), [], "no daemon");
});

test("a process check that never answers cannot hold discovery past its timeout", async t => {
  const { f } = await discovery(t);
  const stalled = async (command, args, options) => command === "/bin/ps"
    ? new Promise(() => {}) : f.run(command, args, options);
  const { discoverNativeSessions } = createCodexDiscovery({ run: stalled, open: f.open });
  const started = Date.now();
  assert.deepEqual(await discoverNativeSessions({ env: f.context.env, home: f.context.home,
    timeoutMs: 200 }), []);
  assert.ok(Date.now() - started < 1_000, `returned after ${Date.now() - started} ms`);
});

test("every process check discovery starts is bounded by its timeout", async t => {
  const { f, discover } = await discovery(t);
  const timeouts = [];
  const { discoverNativeSessions } = createCodexDiscovery({ open: f.open,
    run: async (command, args, options) => { timeouts.push(options?.timeout);
      return f.run(command, args, options); } });
  await discoverNativeSessions({ env: f.context.env, home: f.context.home, timeoutMs: 300 });
  assert.ok(timeouts.length >= 2, "ps and lsof both ran");
  assert.deepEqual([...new Set(timeouts)], [300]);
  assert.equal((await discover()).length, 1);
});
