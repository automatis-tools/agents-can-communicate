import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createClaudeCodeAdapter } from "@agents-can-communicate/adapter-claude-code";
import { recordInstall } from "@agents-can-communicate/installer";
import { runHook } from "../src/runner.mjs";

const exec = promisify(execFile);
const binary = path.resolve(import.meta.dirname, "../../../bin/acc.mjs");
const claudeCodeAdapter = createClaudeCodeAdapter();
const consent = { ACC_NATIVE_DELIVERY_POLICY: "actionable" };

async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-attempt-")));
  const project = path.join(home, "project");
  const dataHome = path.join(home, "data");
  await mkdir(project);
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1", PATH: "",
    GIT_DIR: "", GIT_WORK_TREE: "" };
  const doctor = async (json = true) => {
    const { stdout } = await exec(process.execPath,
      [binary, "doctor", "--cwd", project, ...(json ? ["--json"] : [])], { env });
    return json ? JSON.parse(stdout).data.adapters.find(a => a.adapterId === "claude_code")
      .nativeDelivery.sessions : stdout;
  };
  const hook = async (name, { kind = "SessionStart", policy = consent, pid = true,
    bindNativeSession, policySource } = {}) => {
    const adapter = { ...claudeCodeAdapter,
      nativeDelivery: { ...claudeCodeAdapter.nativeDelivery,
        ...(policySource ? { policySource } : {}) },
      ...(bindNativeSession ? { bindNativeSession } : {}) };
    const result = await runHook({ adapterId: adapter.id, adapters: { [adapter.id]: adapter },
      payload: { hook_event_name: kind, session_id: name, cwd: project,
        prompt: "secret-prompt-must-not-be-recorded" }, dataHome, env: { ...env, ...policy },
      readProcessTable: async () => pid
        ? new Map([[process.pid, { ppid: 1, comm: "claude" }]]) : new Map(),
      probeClientVersion: async () => "2.1.266", platform: "darwin-arm64" });
    assert.equal(result.failed, undefined, result.reason);
    assert.equal(result.timedOut, undefined);
    return result;
  };
  const bindingFile = async name => {
    const entries = await readdir(dataHome, { recursive: true });
    for (const entry of entries.filter(file => file.endsWith(".json") && file.includes("bindings"))) {
      const file = path.join(dataHome, entry);
      const record = JSON.parse(await readFile(file, "utf8"));
      if (record.harnessSessionId === name) return { file, record };
    }
    throw new Error(`missing hook owner ${name}`);
  };
  const attemptFile = async name => {
    const { file, record: owner } = await bindingFile(name);
    const target = path.join(path.dirname(path.dirname(file)), "native-attempts", path.basename(file));
    return { file: target, record: JSON.parse(await readFile(target, "utf8")), owner };
  };
  return { home, dataHome, doctor, hook, bindingFile, attemptFile };
}

test("doctor preserves the hook's missing consent and PID failures per session", async t => {
  const m = await machine(t);
  const missing = await m.hook("missing", { policy: {} });
  const unknown = await m.hook("unknown", { pid: false });
  const sessions = await m.doctor();
  assert.ok(Array.isArray(sessions), "doctor discarded the hook's native binding outcomes");
  assert.equal(JSON.stringify(sessions).includes(unknown.generation), false,
    "doctor leaked the session mutation credential");
  const a = sessions.find(s => s.sessionId === missing.accSessionId);
  const b = sessions.find(s => s.sessionId === unknown.accSessionId);
  assert.equal(a.lastAttempt.policyStatus, "missing");
  assert.equal(a.lastAttempt.state, "off");
  assert.equal(b.lastAttempt.reasonCode, "client_process_unknown");
  assert.equal(b.lastAttempt.policy, "actionable");
  assert.equal(b.lastAttempt.clientProcess, "unknown");
  assert.match(await m.doctor(false), /client process could not be identified/);
  assert.match(await m.doctor(false), /delivery policy was absent/);
  assert.doesNotMatch(JSON.stringify(sessions), /secret-prompt/);
});

test("a later turn replaces the failed attempt; old success never claims current delivery", async t => {
  const m = await machine(t);
  const failed = await m.hook("retry", { bindNativeSession: async () => {
    throw new Error("secret-endpoint-and-vendor-error");
  } });
  let [session] = await m.doctor();
  assert.equal(session?.lastAttempt?.reasonCode, "handshake_failed");
  const active = await m.hook("retry", { kind: "UserPromptSubmit", bindNativeSession: async () => ({
    supported: true, clientVersion: "2.1.266", protocolContract: "claude-code-channel-mcp-v1",
    modes: ["livePush"], opaqueEndpointRef: "secret-endpoint-and-vendor-error",
    leaseUntil: new Date(Date.now() + 60_000).toISOString(), reasonCode: null }) });
  [session] = await m.doctor();
  assert.equal(session.lastAttempt.state, "active");
  assert.equal(session.sessionId, failed.accSessionId);
  assert.equal(session.runtime, "active");
  await active.service.clearDeliveryBinding({ sessionId: failed.accSessionId,
    generation: active.generation ?? failed.generation });
  [session] = await m.doctor();
  assert.equal(session.lastAttempt.state, "active");
  assert.equal(session.runtime, "unbound");
  const { record } = await m.attemptFile("retry");
  assert.equal(record.attempt.state, "active");
  assert.equal(Array.isArray(record.attempt), false);
  assert.doesNotMatch(JSON.stringify(record), /secret-/);
});

test("doctor ignores superseded or corrupt attempts and closed sessions", async t => {
  const m = await machine(t);
  const started = await m.hook("restart", { pid: false });
  const { file, record } = await m.attemptFile("restart");
  assert.equal(record.attempt?.reasonCode, "client_process_unknown");
  await writeFile(file, JSON.stringify({ ...record, generation: "generation_obsolete" }));
  assert.equal((await m.doctor())[0].lastAttempt, null);
  await writeFile(file, JSON.stringify({ ...record,
    attempt: { ...record.attempt, reasonCode: "secret-vendor-output" } }));
  assert.equal((await m.doctor())[0].lastAttempt, null);
  await writeFile(file, JSON.stringify({ ...record, attempt: {
    ...record.attempt, prompt: "secret-extra-property" } }));
  assert.doesNotMatch(JSON.stringify(await m.doctor()), /secret-extra-property/);
  await writeFile(file, JSON.stringify(record));
  await started.service.closeSession({ sessionId: started.accSessionId, generation: started.generation });
  assert.deepEqual(await m.doctor(), []);
  const fresh = await m.hook("restart", { policy: { ACC_NATIVE_DELIVERY_POLICY: "off" } });
  const [session] = await m.doctor();
  assert.notEqual(session.sessionId, started.accSessionId);
  assert.equal(session.sessionId, fresh.sessions[0].sessionId);
  assert.equal(session.lastAttempt.policyStatus, "off");
  assert.equal(session.lastAttempt.reasonCode, null);
});

test("handshake timeout and recorded consent survive into doctor without vendor output", async t => {
  const m = await machine(t);
  await recordInstall({ dataHome: m.dataHome, adapterId: "claude_code", version: "2.1.266",
    artifacts: [], deliveryPolicy: "all" });
  await m.hook("timeout", { policySource: "installation-record", policy: {},
    bindNativeSession: async () => new Promise(() => {}) });
  const [session] = await m.doctor();
  assert.equal(session?.lastAttempt?.reasonCode, "handshake_timeout");
  assert.equal(session.lastAttempt.policy, "all");
  assert.equal(session.lastAttempt.policySource, "installation-record");
});


test("diagnostic write failure cannot discard an otherwise successful hook", async t => {
  const m = await machine(t);
  await m.hook("write-failure", { bindNativeSession: async () => {
    const { file } = await m.bindingFile("write-failure");
    await writeFile(path.join(path.dirname(path.dirname(file)), "native-attempts"), "blocked");
    throw new Error("private-handshake-failure");
  } });
  const [session] = await m.doctor();
  assert.equal(session.lastAttempt, null);
  assert.equal(session.runtime, "unbound");
  assert.match(await m.doctor(false), /no native binding attempt observed/);
  assert.doesNotMatch(await m.doctor(false), /private-handshake-failure/);
});

test("slow diagnostic I/O cannot hold the hook process open or replace its owner", async t => {
  const m = await machine(t);
  await m.hook("slow", { pid: false });
  const before = await m.bindingFile("slow");
  const preload = path.join(m.home, "slow-diagnostic.mjs");
  await writeFile(preload, `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const write = fs.writeFile;
    fs.writeFile = async (file, ...args) => {
      if (String(file).includes("native-attempts")) await new Promise(r => setTimeout(r, 9000));
      return write(file, ...args);
    };
    syncBuiltinESMExports();
  `);
  const child = exec(process.execPath, ["--import", preload,
    path.resolve(import.meta.dirname, "../../../bin/acc-hook.mjs"), "claude_code"], {
    cwd: path.join(m.home, "project"), timeout: 3000,
    env: { HOME: m.home, ACC_DATA_HOME: m.dataHome, ACC_NO_UPDATE_CHECK: "1", PATH: "",
      ACC_NATIVE_DELIVERY_POLICY: "off", GIT_DIR: "", GIT_WORK_TREE: "" },
  });
  child.child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "slow",
    cwd: path.join(m.home, "project"), prompt: "continue" }));
  const { stdout } = await child;
  assert.match(stdout, /ACC|acc/);
  assert.deepEqual((await m.bindingFile("slow")).record, before.record,
    "optional diagnostic I/O rewrote functional hook ownership");
  assert.equal((await m.doctor())[0].lastAttempt.reasonCode, "client_process_unknown",
    "an abandoned diagnostic was published after its deadline");
  const driver = path.join(m.home, "near-deadline.mjs");
  await writeFile(driver, `
    import { runHook } from ${JSON.stringify(new URL("../src/runner.mjs", import.meta.url).href)};
    import { createClaudeCodeAdapter } from ${JSON.stringify(new URL(
      "../../adapter-claude-code/src/adapter.mjs", import.meta.url).href)};
    const original = createClaudeCodeAdapter();
    const adapter = { ...original, normalizeHook: async payload => {
      await new Promise(r => setTimeout(r, 1750));
      return original.normalizeHook(payload);
    } };
    const result = await runHook({ adapterId: adapter.id, adapters: { [adapter.id]: adapter },
      budgetMs: 2000, dataHome: process.env.ACC_DATA_HOME, env: process.env,
      payload: { hook_event_name: "UserPromptSubmit", session_id: "slow", cwd: process.cwd() } });
    process.stdout.write(JSON.stringify({ timedOut: result.timedOut, failed: result.failed,
      stdout: result.stdout }));
  `);
  const nearDeadline = JSON.parse((await exec(process.execPath, ["--import", preload, driver], {
    cwd: path.join(m.home, "project"), timeout: 3000,
    env: { HOME: m.home, ACC_DATA_HOME: m.dataHome, ACC_NO_UPDATE_CHECK: "1", PATH: "",
      ACC_NATIVE_DELIVERY_POLICY: "off", GIT_DIR: "", GIT_WORK_TREE: "" },
  })).stdout);
  assert.equal(nearDeadline.timedOut, undefined,
    "optional diagnostics consumed the remaining functional hook budget");
  assert.equal(nearDeadline.failed, undefined);
  assert.match(nearDeadline.stdout, /ACC|acc/);
  await m.hook("slow", { policy: { ACC_NATIVE_DELIVERY_POLICY: "off" } });
  assert.equal((await m.doctor())[0].lastAttempt.policyStatus, "off",
    "a dead diagnostic writer prevented a subsequent session from recording its result");
});
