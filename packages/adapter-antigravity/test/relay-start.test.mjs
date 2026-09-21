import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { storeSessionBinding } from "@agents-can-communicate/adapter-sdk";

import { REFUSALS, cleanEnv, findConversation, startRelay } from "../src/relay-start.mjs";

const CONVERSATION = "3ed65ea5-31f2-4ddf-b6c7-e3c85a9a3c29";
const ENV = { PATH: "/usr/bin", HOME: "/Users/someone", ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
  ANTIGRAVITY_CSRF_TOKEN: "fake-token", ANTIGRAVITY_CONVERSATION_ID: CONVERSATION };
const FOUND = { runtimeDir: "/data/acc/workspaces/w1", workspaceId: "w1",
  binding: { accSessionId: "session_1", generation: "g1", clientPid: 4242 } };

function ports(overrides = {}) {
  const spawned = [];
  return { spawned, env: ENV, pid: 555,
    readTable: async () => new Map(), resolveAgyPid: () => 4242,
    argvOf: async () => ["agy", "--add-dir", "."],
    readPolicy: async () => "actionable",
    findConversation: async () => FOUND,
    liveRelayFor: async () => false,
    spawnRun: async options => { spawned.push(options); return { ok: true }; },
    ...overrides };
}

test("each precondition refuses with its own line and starts nothing", async () => {
  const cases = [
    [{ env: { PATH: "/usr/bin", ANTIGRAVITY_CONVERSATION_ID: CONVERSATION } }, REFUSALS.noEndpoint],
    [{ resolveAgyPid: () => null }, REFUSALS.notUnderAgy],
    [{ argvOf: async () => ["agy", "-p", "hi"] }, REFUSALS.printMode],
    [{ readPolicy: async () => "off" }, REFUSALS.policyOff],
    [{ findConversation: async () => null }, REFUSALS.noSession],
    [{ liveRelayFor: async () => true }, REFUSALS.alreadyRunning],
  ];
  for (const [override, line] of cases) {
    const p = ports(override);
    assert.equal(await startRelay(p), line);
    assert.deepEqual(p.spawned, [], `${line} must not start a relay`);
  }
});

test("the relay starts without the endpoint in its environment", async () => {
  const p = ports();

  assert.equal(await startRelay(p), "ACC: live delivery is running for this conversation.");

  const [spawn] = p.spawned;
  for (const name of ["ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN", "ANTIGRAVITY_CONVERSATION_ID"]) {
    assert.equal(Object.hasOwn(spawn.env, name), false, `${name} leaked into the relay's environment`);
  }
  assert.equal(spawn.env.PATH, "/usr/bin");
  assert.deepEqual(spawn.payload, { lsAddress: "127.0.0.1:1", csrfToken: "fake-token",
    conversationId: CONVERSATION, agyPid: 4242, runtimeDir: FOUND.runtimeDir, workspaceId: "w1" });
});

test("a relay that never reports ready is said to have failed, and nothing throws", async () => {
  const late = ports({ spawnRun: async () => ({ ok: false, reason: "no ready line within 10 seconds" }) });
  assert.equal(await startRelay(late), "ACC: live delivery did not start (no ready line within "
    + "10 seconds); peers still reach this conversation at its next turn.");
  const broken = ports({ readTable: async () => { throw new Error("ps failed"); } });
  assert.equal(await startRelay(broken),
    "ACC: live delivery did not start; peers still reach this conversation at its next turn.");
});

test("cleanEnv removes exactly the endpoint", () => {
  assert.deepEqual(cleanEnv(ENV), { PATH: "/usr/bin", HOME: "/Users/someone" });
});

test("the conversation is found by its id, in whichever workspace opened it", async t => {
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-find-")));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const workspace = id => path.join(dataHome, "acc", "workspaces", id);
  await storeSessionBinding({ runtimeDir: workspace("w_other"), harnessSessionId: "another-conversation",
    accSessionId: "session_0", generation: "g0", clientPid: 4242 });
  await storeSessionBinding({ runtimeDir: workspace("w_mine"), harnessSessionId: CONVERSATION,
    accSessionId: "session_1", generation: "g1", clientPid: 4242 });

  const found = await findConversation({ dataHome, conversationId: CONVERSATION, agyPid: 4242 });
  assert.equal(found.runtimeDir, workspace("w_mine"));
  assert.equal(found.workspaceId, "w_mine");
  assert.equal(found.binding.accSessionId, "session_1");

  assert.equal(await findConversation({ dataHome, conversationId: CONVERSATION, agyPid: 9999 }), null,
    "another client's session is never adopted");
  await storeSessionBinding({ runtimeDir: workspace("w_twin"), harnessSessionId: CONVERSATION,
    accSessionId: "session_2", generation: "g2", clientPid: 4242 });
  assert.equal(await findConversation({ dataHome, conversationId: CONVERSATION, agyPid: 4242 }), null,
    "two candidates name nobody");
  assert.equal(await findConversation({ dataHome: path.join(dataHome, "absent"),
    conversationId: CONVERSATION, agyPid: 4242 }), null);
});
