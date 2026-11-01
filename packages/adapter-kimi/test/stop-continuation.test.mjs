import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runHook } from "@agents-can-communicate/hook-runner";

import { createKimiAdapter } from "../src/adapter.mjs";
import { stopOutcome, stopResponse } from "../src/hooks.mjs";

const payload = { hook_event_name: "Stop", stop_hook_active: false };
const allowed = { reason: "peer body", payload, clientVersion: "2.4.0", livePolicy: "actionable" };

test("Stop continuation uses Kimi's structured denial and fails open", () => {
  const response = stopResponse(allowed);
  assert.equal(response.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(response.hookSpecificOutput.permissionDecisionReason, "peer body");
  assert.match(stopOutcome(allowed).stdout, /peer body/);

  for (const change of [{ reason: " " }, { payload: { hook_event_name: "StopFailure",
    stop_hook_active: false } }, { payload: { hook_event_name: "Stop", stop_hook_active: true } },
  { clientVersion: "0.36.1" }, { clientVersion: null }, { livePolicy: "off" },
  { livePolicy: undefined }]) {
    assert.deepEqual(stopResponse({ ...allowed, ...change }), {}, JSON.stringify(change));
    assert.equal(stopOutcome({ ...allowed, ...change }).stdout, "");
  }
  assert.deepEqual(stopResponse({ ...allowed, clientVersion: "2.4.0-rc.1",
    livePolicy: "all" }).hookSpecificOutput.permissionDecision, "deny");
});

const captured = async name => JSON.parse(await readFile(
  new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-kimi-stop-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-kimi-stop-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  await mkdir(path.join(dataHome, "acc"), { recursive: true });
  await writeFile(path.join(dataHome, "acc", "installs.json"), JSON.stringify({
    schemaVersion: 1, installs: [{ adapterId: "kimi", deliveryPolicy: "actionable" }] }));
  const invoke = (body, eventName) => runHook({ includeSessions: true, adapterId: "kimi",
    payload: body, args: [eventName], adapters: { kimi: createKimiAdapter() }, dataHome,
    readProcessTable: async () => new Map(), probeClientVersion: async () => "2.4.0",
    platform: "darwin-arm64" });
  const as = async (name, sessionId, extra = {}) => ({ ...await captured(name), session_id: sessionId,
    cwd: root, ...extra });
  return { invoke, as };
}

test("a peer message rides Stop through the real runner and recorded opt-in", async t => {
  const { invoke, as } = await place(t);
  const recipient = await invoke(await as("SessionStart", "session_recipient"), "SessionStart");
  const peer = await invoke(await as("SessionStart", "session_peer"), "SessionStart");
  const participantId = recipient.sessions
    .find(session => session.sessionId === recipient.accSessionId).participantId;
  const message = await peer.service.sendMessage({ sessionId: peer.accSessionId,
    generation: peer.generation, clientMessageId: "client_kimi_stop", toParticipantIds: [participantId],
    kind: "question", obligation: "reply", subject: "stop probe", body: "delivered at turn end" });

  const stop = await invoke(await as("Stop", "session_recipient"), "Stop");
  const answer = JSON.parse(stop.stdout);
  assert.equal(answer.hookSpecificOutput.permissionDecision, "deny");
  assert.match(answer.hookSpecificOutput.permissionDecisionReason, new RegExp(message.messageId));
  assert.match(answer.hookSpecificOutput.permissionDecisionReason, /delivered at turn end/);

  const again = await invoke(await as("Stop", "session_recipient", { stop_hook_active: true }), "Stop");
  assert.equal(again.stdout, "");
});

test("a Stop with nothing waiting lets the turn end", async t => {
  const { invoke, as } = await place(t);
  await invoke(await as("SessionStart", "session_alone"), "SessionStart");
  const stop = await invoke(await as("Stop", "session_alone"), "Stop");
  assert.equal(stop.stdout, "");
  assert.equal(stop.exitCode, 0);
});
