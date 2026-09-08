import assert from "node:assert/strict";
import test from "node:test";

import { withServer } from "./stdio-harness.mjs";

// Real Codex 0.153.4 and Claude Code 2.1.263 start with initialize at these
// revisions, without per-request _meta. The previous harness skipped that
// handshake entirely. These literal requests exercise the public stdio binary.
const initialize = (protocolVersion, overrides = {}) => ({ protocolVersion,
  capabilities: { roots: { listChanged: true } },
  clientInfo: { name: "self_reported_not_the_participant", version: "1.0.0" },
  ...overrides });
const ready = child => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0",
  method: "notifications/initialized" })}\n`);

for (const version of ["2025-06-18", "2025-11-25"]) {
  test(`an initialized ${version} client discovers and uses ACC tools`, async t => {
    await withServer(t, async ({ request, child }) => {
      const opened = await request("initialize", initialize(version));
      assert.equal(opened.error, undefined, JSON.stringify(opened.error));
      assert.equal(opened.result.protocolVersion, version);
      assert.equal(opened.result.serverInfo.name, "agents-can-communicate");
      assert.deepEqual(opened.result.capabilities, { tools: {}, resources: {} });
      assert.equal(Object.hasOwn(opened.result, "resultType"), false);
      ready(child);

      const listed = await request("tools/list", {});
      assert.equal(listed.error, undefined, JSON.stringify(listed.error));
      assert.equal(listed.result.tools.some(tool => tool.name === "acc_inbox"), true);
      assert.equal(Object.hasOwn(listed.result, "resultType"), false);
      const worked = await request("tools/call", { name: "acc_work",
        arguments: { summary: "Reviewing the actual material", mode: "review" } });
      assert.equal(worked.error, undefined, JSON.stringify(worked.error));
      assert.notEqual(worked.result.isError, true);
      const status = await request("tools/call", { name: "acc_status", arguments: {} });
      assert.deepEqual(status.result.structuredContent.participants
        .map(p => p.participantId), ["mcp_client"], "clientInfo must not choose identity");
      assert.deepEqual(await request("ping", {}, "still-alive"), {
        jsonrpc: "2.0", id: "still-alive", result: {} });
      const inbox = await request("tools/call", { name: "acc_inbox", arguments: {} });
      assert.deepEqual(inbox.result.structuredContent, { items: [], nextCursor: null });
      assert.deepEqual(JSON.parse(inbox.result.content[0].text), { items: [], nextCursor: null });
      const invalid = await request("tools/call", { name: "acc_work", arguments: {} });
      assert.equal(invalid.result.isError, true);
      assert.match(invalid.result.content[0].text, /acc_work/);
    });
  });
}

test("an unsupported initialize version negotiates an initialized revision", async t => {
  await withServer(t, async ({ request, child }) => {
    const opened = await request("initialize", initialize("2099-01-01"));
    assert.equal(opened.error, undefined, JSON.stringify(opened.error));
    assert.equal(opened.result.protocolVersion, "2025-11-25");
    ready(child);
    const result = await request("resources/list", {});
    assert.equal(result.result.resources.some(r => r.uri === "acc://inbox"), true);
  });
});

test("malformed initialize does not admit requests or poison a later valid handshake", async t => {
  await withServer(t, async ({ request, child }) => {
    for (const params of [null, {}, initialize(7),
      initialize("2025-11-25", { capabilities: [] }),
      initialize("2025-11-25", { clientInfo: null })]) {
      const response = await request("initialize", params);
      assert.equal(response.error?.code, -32602, JSON.stringify(response));
    }
    const premature = await request("tools/list", {});
    assert.equal(premature.error?.code, -32602);
    const valid = await request("initialize", initialize("2025-11-25"));
    assert.equal(valid.error, undefined, JSON.stringify(valid.error));
    ready(child);
    assert.equal((await request("tools/list", {})).error, undefined);
  });
});

test("initialize readiness is acknowledged by the client notification", async t => {
  await withServer(t, async ({ request, child }) => {
    await request("initialize", initialize("2025-11-25"));
    const early = await request("tools/list", {});
    assert.equal(early.error?.code, -32600);
    ready(child);
    assert.equal((await request("tools/list", {})).error, undefined);
    const repeated = await request("initialize", initialize("2025-06-18"));
    assert.equal(repeated.error?.code, -32600);
    assert.equal((await request("tools/list", {})).error, undefined);
  });
});

test("legacy initialization never supplies missing modern request metadata", async t => {
  await withServer(t, async ({ request, child, meta }) => {
    await request("initialize", initialize("2025-11-25"));
    ready(child);
    const incomplete = await request("tools/list", { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
    assert.equal(incomplete.error?.code, -32602);
    for (const capabilities of [null, [], "tools"]) {
      const malformed = await request("tools/list", { _meta: { ...meta,
        "io.modelcontextprotocol/clientCapabilities": capabilities } });
      assert.equal(malformed.error?.code, -32602);
    }
    const unsupported = await request("tools/list", { _meta: { ...meta,
      "io.modelcontextprotocol/protocolVersion": "1999-01-01" } });
    assert.equal(unsupported.error?.code, -32022);
    const modern = await request("tools/list", { _meta: meta });
    assert.equal(modern.error, undefined, JSON.stringify(modern.error));
    assert.equal(modern.result.resultType, "complete");
    const modernInbox = await request("tools/call", { name: "acc_inbox",
      arguments: {}, _meta: meta });
    assert.deepEqual(modernInbox.result.structuredContent, { items: [], nextCursor: null });
    const legacy = await request("tools/list", { _meta: { arbitrary: "extension" } });
    assert.equal(legacy.error, undefined, JSON.stringify(legacy.error));
    assert.equal(Object.hasOwn(legacy.result, "resultType"), false);
  });
});

test("restarting an initialized MCP process preserves the configured ACC participant", async t => {
  const location = {};
  let sessionId;
  await withServer(t, async ({ request, child, workspace, dataHome }) => {
    Object.assign(location, { workspace, dataHome });
    await request("initialize", initialize("2025-06-18"));
    ready(child);
    const status = await request("tools/call", { name: "acc_status", arguments: {} });
    sessionId = status.result.structuredContent.participants[0].sessionId;
  });
  await withServer(t, async ({ request, child }) => {
    await request("initialize", initialize("2025-11-25", {
      clientInfo: { name: "different_client", version: "2.0.0" } }));
    ready(child);
    const status = await request("tools/call", { name: "acc_status", arguments: {} });
    const participants = status.result.structuredContent.participants;
    assert.equal(participants.length, 1);
    assert.equal(participants[0].sessionId, sessionId);
  }, { reuse: location });
});
