import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const runner = new URL("../src/runner.mjs", import.meta.url).href;

const program = `
  const { runHook } = await import(${JSON.stringify(runner)});
  const adapter = {
    id: "fixture",
    client: { command: "fixture" },
    capabilities: {},
    normalizeHook: payload => payload,
    injectOutcome: context => ({ stdout: context, stderr: "", exitCode: 0 }),
    renderContext: () => "",
  };
  const result = await runHook({
    adapterId: adapter.id,
    adapters: { [adapter.id]: adapter },
    dataHome: process.env.ACC_TEST_DATA_HOME,
    payload: { kind: "beforeTurn", sessionId: "missed-startup",
      cwd: process.env.ACC_TEST_WORKSPACE, targets: [] },
    readProcessTable: async () => new Map(),
    probeClientVersion: async () => "1.0.0",
  });
  process.stdout.write(JSON.stringify({ stdout: result.stdout,
    sessions: result.sessions, failed: result.failed,
    reason: result.reason }));
`;

async function invoke(env) {
  const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", program],
    { env: { ...process.env, ...env } });
  return JSON.parse(stdout);
}

test("a beforeTurn in a later process recovers a startup hook that never bound", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-hook-process-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-data-process-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const env = { ACC_TEST_DATA_HOME: dataHome, ACC_TEST_WORKSPACE: root };

  const first = await invoke(env);
  const second = await invoke(env);
  const [owner] = first.sessions;

  assert.equal(first.failed, undefined, first.reason);
  assert.equal(typeof owner.sessionId, "string");
  assert.match(first.stdout, new RegExp(`--session ${owner.sessionId}`));
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].sessionId, owner.sessionId);
  assert.match(second.stdout, new RegExp(`--session ${owner.sessionId}`));
});
