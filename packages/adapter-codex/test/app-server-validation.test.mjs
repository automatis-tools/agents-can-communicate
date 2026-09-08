import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { locateCodexThread, probeCodexQueue } from "../src/app-server-client.mjs";

const THREAD = "01a063ed-a384-7fe2-b443-7fedf1593f6b";
const peerFor = responses => ({
  notify() {},
  async request(method, params) {
    if (method === "initialize") return { userAgent: "codex/0.152.1 (Mac OS)" };
    const response = responses[method];
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response(params) : response;
  },
});

// A timeout used to mean "the method exists", making a broken probe eligible.
test("queue timeout and malformed responses never prove protocol support", async () => {
  for (const response of [Object.assign(new Error("private server detail"), { code: "ETIMEDOUT" }),
    {}, { data: null }, { data: {} }, { data: [{}] }]) {
    const result = await probeCodexQueue(peerFor({ "thread/queue/list": response }),
      { threadId: THREAD });
    assert.equal(result.supported, false);
    assert.equal(JSON.stringify(result).includes("private server detail"), false);
  }
});

// Exhausting or cycling a cursor must not certify a partial inventory as complete.
test("thread discovery rejects malformed, cycling, and unbounded pages", async () => {
  for (const response of [{}, { data: THREAD },
    { data: [THREAD], nextCursor: "cycle" },
    (() => { let page = 0; return () => ({ data: [THREAD], nextCursor: String(++page) }); })()]) {
    const peer = peerFor({ "thread/loaded/list": response,
      "thread/list": { data: [{ id: THREAD, cwd: tmpdir(), status: { type: "idle" } }],
        nextCursor: null } });
    await assert.rejects(locateCodexThread(peer, { threadId: THREAD }), { code: "EPROTOCOL" });
  }
});

test("thread cwd comparison accepts a real alias and rejects another directory", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cwd-proof-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = `${root}-alias`;
  await symlink(root, alias, "dir");
  t.after(() => rm(alias, { force: true }));
  const peer = peerFor({ "thread/loaded/list": { data: ["other", THREAD], nextCursor: null },
    "thread/list": { data: [
      { id: "other", cwd: root, status: { type: "idle" } },
      { id: THREAD, cwd: alias, status: { type: "active" } },
    ], nextCursor: null } });
  assert.deepEqual(await locateCodexThread(peer, { threadId: THREAD, cwd: root }),
    { found: true, threadId: THREAD, cwd: root, status: "active" });
  assert.equal((await locateCodexThread(peer, { threadId: THREAD, cwd: tmpdir() })).found, false);
});

test("missing cwd and non-live status cannot supply a usable thread address", async () => {
  for (const entry of [{ id: THREAD, status: { type: "idle" } },
    { id: THREAD, cwd: tmpdir(), status: { type: "notLoaded" } },
    { id: THREAD, cwd: tmpdir(), status: { type: "unknown" } }]) {
    const peer = peerFor({ "thread/loaded/list": { data: [THREAD], nextCursor: null },
      "thread/list": { data: [entry], nextCursor: null } });
    assert.equal((await locateCodexThread(peer, { threadId: THREAD })).found, false);
  }
});
