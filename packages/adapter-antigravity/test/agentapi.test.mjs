import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ENDPOINT_VARIABLES, agentApiCommand, childEnv, classifyAnswer, createAgentApi, endpointFrom }
  from "../src/agentapi.mjs";

const CONVERSATION = "3ed65ea5-31f2-4ddf-b6c7-e3c85a9a3c29";
const endpoint = { lsAddress: "127.0.0.1:63476", csrfToken: "fake-token-value",
  conversationId: CONVERSATION };
// Shapes captured on 1.2.7 (fixtures/agentapi-live-push-1.2.7.json,
// fixtures/agentapi-reachability-1.2.7.json, fixtures/live-push-surfaces-1.2.7.json).
const ACCEPTED = JSON.stringify({ response: { sendMessage: { recipientId: CONVERSATION,
  content: "x" } } });
const UNAVAILABLE = JSON.stringify({ response: {},
  error: "rpc error: code = Unavailable desc = connection error: desc = \"transport\"" });
const UNAUTHENTICATED = JSON.stringify({ response: {},
  error: "rpc error: code = Unauthenticated desc = missing CSRF token" });

test("the endpoint is read from the agent shell and nothing else", () => {
  assert.deepEqual(endpointFrom({ ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
    ANTIGRAVITY_CSRF_TOKEN: "t", ANTIGRAVITY_CONVERSATION_ID: "c-1234567" }),
  { lsAddress: "127.0.0.1:1", csrfToken: "t", conversationId: "c-1234567" });
  assert.equal(endpointFrom({ ANTIGRAVITY_CONVERSATION_ID: "c-1234567" }), null,
    "a hook's environment - the conversation id alone - is not an endpoint");
});

test("the child environment carries the endpoint and the parent's does not", () => {
  const base = { PATH: "/usr/bin", ANTIGRAVITY_CSRF_TOKEN: "stale", HOME: "/h" };
  const env = childEnv(base, endpoint);
  assert.equal(env.ANTIGRAVITY_CSRF_TOKEN, "fake-token-value");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(base.ANTIGRAVITY_CSRF_TOKEN, "stale", "the base environment is not mutated");
  assert.deepEqual(ENDPOINT_VARIABLES, ["ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN",
    "ANTIGRAVITY_CONVERSATION_ID"]);
});

test("answers map to the router's closed codes", () => {
  assert.deepEqual(classifyAnswer(ACCEPTED, CONVERSATION), { ok: true, reasonCode: null });
  assert.deepEqual(classifyAnswer(ACCEPTED, "another-conversation"),
    { ok: false, reasonCode: "transport_rejected" }, "a different recipient is not a delivery");
  assert.deepEqual(classifyAnswer(UNAVAILABLE, CONVERSATION),
    { ok: false, reasonCode: "recipient_unavailable" });
  assert.deepEqual(classifyAnswer(UNAUTHENTICATED, CONVERSATION),
    { ok: false, reasonCode: "transport_rejected" });
  assert.deepEqual(classifyAnswer("not json", CONVERSATION),
    { ok: false, reasonCode: "transport_error" });
});

test("sendMessage passes the endpoint only through the child environment", async () => {
  const calls = [];
  const api = createAgentApi({ endpoint, baseEnv: { PATH: "/usr/bin" },
    run: async (command, args, options) => { calls.push({ command, args, options });
      return { stdout: ACCEPTED }; } });

  assert.deepEqual(await api.sendMessage("hello"), { ok: true, reasonCode: null });
  const [call] = calls;
  assert.equal(call.command, "agy");
  assert.deepEqual(call.args, ["agentapi", "send-message", "--title", "ACC peer message",
    CONVERSATION, "hello"]);
  assert.equal(JSON.stringify(call.args).includes("fake-token-value"), false,
    "the token never appears in argv, which any process can read");
  assert.equal(call.options.env.ANTIGRAVITY_CSRF_TOKEN, "fake-token-value");
});

test("a runner that throws or times out is a transport error, never a crash", async () => {
  const api = createAgentApi({ endpoint, run: async () => { throw new Error("ETIMEDOUT"); } });
  assert.deepEqual(await api.sendMessage("x"), { ok: false, reasonCode: "transport_error" });
  assert.deepEqual(await api.conversationMetadata(), { ok: false, reasonCode: "transport_error" });
});

test("failures are read from stdout, where agy prints them", async () => {
  // Captured: every refusal is a JSON answer on stdout with exit status 1 and an
  // empty stderr - fixtures/agentapi-error-answers-1.2.7.json.
  const { answers } = JSON.parse(await readFile(new URL(
    "../fixtures/agentapi-error-answers-1.2.7.json", import.meta.url), "utf8"));
  const [unset, closed] = answers.map(answer => classifyAnswer(JSON.stringify(answer.stdout), "c"));
  assert.deepEqual(unset, { ok: false, reasonCode: "transport_error" });
  assert.deepEqual(closed, { ok: false, reasonCode: "recipient_unavailable" });
});

test("the relay runs the agy the client names, and falls back to the PATH", async t => {
  // Captured: in the agent's shell ANTIGRAVITY_AGENTAPI_EXE names the same agy
  // binary the client runs. Preferring it keeps a push working for a client
  // started by a full path that is not on the PATH.
  const { chmod, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = await mkdtemp(path.join(tmpdir(), "acc-agy-exe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agy = path.join(dir, "agy");
  await writeFile(agy, "#!/bin/sh\n");
  await chmod(agy, 0o755);
  const other = path.join(dir, "agentapi");
  await writeFile(other, "#!/bin/sh\n");
  await chmod(other, 0o755);
  const plain = path.join(dir, "not-executable", "agy");

  assert.equal(agentApiCommand({ ANTIGRAVITY_AGENTAPI_EXE: agy }), agy);
  for (const env of [{}, { ANTIGRAVITY_AGENTAPI_EXE: "agy" }, { ANTIGRAVITY_AGENTAPI_EXE: other },
    { ANTIGRAVITY_AGENTAPI_EXE: plain }, { ANTIGRAVITY_AGENTAPI_EXE: "" }]) {
    assert.equal(agentApiCommand(env), "agy", JSON.stringify(env));
  }
});
