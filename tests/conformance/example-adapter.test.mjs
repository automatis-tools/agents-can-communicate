import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { defineAdapter, mergeOwnedConfig, ownedKeys, projectContext, removeOwnedConfig }
  from "@agents-can-communicate/adapter-sdk";

import { runAdapterConformance } from "./adapter-contract.mjs";

// A reference adapter over a fake harness config. It exists so the conformance
// runner is exercised before any real adapter depends on it: a matrix nothing
// has ever failed is indistinguishable from a matrix that checks nothing.
const roots = [];
after(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

const UNRELATED = { theme: "dark", hooks: { UserPromptSubmit: ["someone-elses-hook"] } };
const ACC_ENTRIES = { accHooks: { SessionStart: ["acc attach"], SessionEnd: ["acc detach"] } };

async function createFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-conformance-")));
  roots.push(root);
  const configPath = path.join(root, "settings.json");
  await writeFile(configPath, `${JSON.stringify(UNRELATED, null, 2)}\n`);

  const read = async () => JSON.parse(await readFile(configPath, "utf8"));
  return {
    context: { configPath, runtimeDir: path.join(root, "runtime") },
    snapshot: read,
    valueOf: async key => (await read())[key],
  };
}

function createAdapter() {
  const read = async context => JSON.parse(await readFile(context.configPath, "utf8"));
  const write = async (context, value) =>
    writeFile(context.configPath, `${JSON.stringify(value, null, 2)}\n`);

  return defineAdapter({
    id: "example_harness",
    displayName: "Example Harness",
    capabilities: {
      lifecycle: { sessionStart: true, sessionEnd: true },
      context: { startupInjection: true },
      delivery: { polling: true },
    },
    startSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    endSession: async () => ({ ok: true, changes: [], diagnostics: [] }),
    poll: async () => ({ ok: true, changes: [], diagnostics: [] }),

    detect: async context => ({ ok: true, changes: [],
      diagnostics: [`config at ${context.configPath}`] }),

    install: async context => {
      const current = await read(context);
      await write(context, mergeOwnedConfig(current, ACC_ENTRIES));
      return { ok: true, changes: Object.keys(ACC_ENTRIES), diagnostics: [] };
    },

    uninstall: async context => {
      const current = await read(context);
      const removed = ownedKeys(current);
      await write(context, removeOwnedConfig(current));
      return { ok: true, changes: removed, diagnostics: [] };
    },

    doctor: async context => {
      const current = await read(context);
      const installed = ownedKeys(current).length > 0;
      return { ok: installed, changes: [],
        diagnostics: [installed ? "acc entries present" : "acc entries missing"] };
    },

    normalizeHook: async payload => ({
      kind: payload.hook_event_name === "SessionStart" ? "sessionStart"
        : payload.hook_event_name === "PreToolUse" ? "beforeTool" : "sessionEnd",
      sessionId: payload.session_id,
      cwd: payload.cwd,
      model: payload.model ?? null,
      parentSessionId: payload.parent_session_id ?? null,
      tool: payload.tool_name ?? null,
    }),

    renderContext: async (sync, options) => projectContext(sync, options),
  });
}

const hookFixtures = {
  sessionStart: { hook_event_name: "SessionStart", session_id: "abc-123", cwd: "/tmp/project",
    model: "example-model", transcript_path: "/should/not/be/copied" },
  beforeTool: { hook_event_name: "PreToolUse", session_id: "abc-123", cwd: "/tmp/project",
    tool_name: "Write", transcript_path: "/should/not/be/copied" },
  sessionEnd: { hook_event_name: "SessionEnd", session_id: "abc-123", cwd: "/tmp/project" },
};

runAdapterConformance("example", { createAdapter, createFixture, hookFixtures });

test("the reference adapter really does preserve unrelated configuration", async () => {
  const fixture = await createFixture();
  const adapter = createAdapter();

  await adapter.install(fixture.context);
  const installed = await fixture.snapshot();
  await adapter.uninstall(fixture.context);

  assert.deepEqual(installed.hooks, UNRELATED.hooks, "install disturbed a foreign hook");
  assert.deepEqual(await fixture.snapshot(), UNRELATED);
});

test("the conformance runner fails an adapter that breaks unrelated config", async () => {
  // Guards the guard: an adapter that overwrites the whole file must not pass.
  const fixture = await createFixture();
  const destructive = { ...createAdapter(),
    install: async context => {
      await writeFile(context.configPath, `${JSON.stringify(ACC_ENTRIES)}\n`);
      return { ok: true, changes: [], diagnostics: [] };
    } };

  await destructive.install(fixture.context);

  assert.equal((await fixture.snapshot()).theme, undefined,
    "the destructive adapter did not actually destroy anything");
  assert.notDeepEqual(await fixture.snapshot(), UNRELATED);
});
