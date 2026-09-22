import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runHook } from "@agents-can-communicate/hook-runner";

import { createAntigravityAdapter } from "../src/adapter.mjs";

// The whole path with the real adapter and the real runner: the Stop payload
// this client sends, the event name as the hook command's argument, and the
// ceiling read from the payload the runner hands back - because the normalised
// event deliberately carries no executionNum. Pinned to the certified client
// and platform so the result does not depend on the machine running it.
const captured = async name => JSON.parse(await readFile(
  new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-agy-stop-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-agy-stop-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const adapters = { antigravity: createAntigravityAdapter() };
  const invoke = (payload, eventName) => runHook({ adapterId: "antigravity", payload,
    args: [eventName], adapters, dataHome, readProcessTable: async () => new Map(),
    probeClientVersion: async () => "1.2.7", platform: "darwin-arm64" });
  const as = async (name, conversationId, extra = {}) => ({ ...await captured(name),
    conversationId, workspacePaths: [root], ...extra });
  return { root, invoke, as };
}

test("a peer message that arrives as a turn ends continues that turn", async t => {
  const { invoke, as } = await place(t);
  const recipient = await invoke(await as("SessionStart-1.2.7", "conversation-recipient"),
    "SessionStart");
  const peer = await invoke(await as("SessionStart-1.2.7", "conversation-peer"),
    "SessionStart");
  const participantId = recipient.sessions
    .find(session => session.sessionId === recipient.accSessionId).participantId;
  const message = await peer.service.sendMessage({ sessionId: peer.accSessionId,
    generation: peer.generation, clientMessageId: "client_stop_probe",
    toParticipantIds: [participantId], kind: "question", obligation: "reply",
    subject: "stop probe", body: "sent while the last answer was being written" });

  const stop = await invoke(await as("Stop-1.2.7", "conversation-recipient"), "Stop");

  const answer = JSON.parse(stop.stdout);
  assert.equal(answer.decision, "continue", "the only value this client continues on");
  assert.match(answer.reason, new RegExp(message.messageId));
  assert.match(answer.reason, /sent while the last answer was being written/);

  // The second Stop of the same turn - executionNum 1, as captured - lets it end.
  const again = await invoke(await as("Stop-continued-1.2.7", "conversation-recipient"),
    "Stop");
  assert.equal(again.stdout, "");
});

test("a Stop with nothing waiting lets the turn end", async t => {
  const { invoke, as } = await place(t);
  await invoke(await as("SessionStart-1.2.7", "conversation-alone"), "SessionStart");

  const stop = await invoke(await as("Stop-1.2.7", "conversation-alone"), "Stop");

  assert.equal(stop.stdout, "");
  assert.equal(stop.exitCode, 0);
});
