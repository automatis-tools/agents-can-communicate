import assert from "node:assert/strict";
import test from "node:test";

import { PUBLIC_TOOLS } from "../src/tools.mjs";
import { withServer } from "./stdio-harness.mjs";

const call = (request, meta, name, args) => request("tools/call",
  { name, arguments: args, _meta: meta });

test("an invalid tool call is rejected before it opens a session", async t => {
  await withServer(t, async ({ request, meta }) => {
    const invalid = await call(request, meta, "acc_status", { priority: "high" });
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /priority/);

    const unknown = await call(request, meta, "acc_teleport", {});
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0].text, /acc_teleport/);

    const roster = await request("resources/read", { uri: "acc://roster", _meta: meta });
    assert.deepEqual(JSON.parse(roster.result.contents[0].text), []);
  });
});

test("every public tool rejects an unknown argument at the server boundary", async t => {
  await withServer(t, async ({ request, meta }) => {
    const minimal = {
      acc_status: {},
      acc_sync: {},
      acc_work: { summary: "Reviewing", mode: "review" },
      acc_claim: { action: "acquire", resource: "file:src/**" },
      acc_release: { claimId: "claim_missing" },
      acc_message: { to: [], subject: "FYI", body: "Recorded." },
      acc_inbox: {},
      acc_reply: { messageId: "message_missing", body: "Done." },
      acc_request: { toParticipantId: "participant_missing", title: "Review" },
      acc_ack: { messageId: "message_missing" },
      acc_finish: { goal: "Hand off" },
    };
    const rejected = [];
    for (const { name } of PUBLIC_TOOLS) {
      const response = await call(request, meta, name,
        { ...minimal[name], legacyField: true });
      if (response.result.isError === true
        && /legacyField/.test(response.result.content[0].text)) rejected.push(name);
    }
    assert.deepEqual(rejected.sort(), PUBLIC_TOOLS.map(tool => tool.name).sort());
  });
});

test("legacy controls are rejected by the live tools/call path", async t => {
  await withServer(t, async ({ request, meta }) => {
    const cases = [
      ["acc_message", { to: [], subject: "x", body: "x", requiresAck: true },
        "requiresAck"],
      ["acc_message", { to: [], subject: "x", body: "x", priority: "high" }, "priority"],
      ["acc_work", { summary: "x", mode: "edit", workstreamId: "workstream_x" },
        "workstreamId"],
      ["acc_ack", { messageId: "message_x", state: "acknowledged" }, "state"],
    ];
    for (const [name, args, field] of cases) {
      const response = await call(request, meta, name, args);
      assert.equal(response.result.isError, true, `${name} accepted ${field}`);
      assert.match(response.result.content[0].text, new RegExp(field));
    }
  });
});

test("required fields, types, enums, and ranges are validated before core", async t => {
  await withServer(t, async ({ request, meta }) => {
    const cases = [
      ["acc_message", { to: [], body: "missing subject" }, "subject"],
      ["acc_message", { to: "participant", subject: "x", body: "x" }, "to"],
      ["acc_message", { to: [], subject: "x", body: "x", kind: "command" }, "kind"],
      ["acc_sync", { limit: 0 }, "limit"],
      ["acc_sync", { limit: "10" }, "limit"],
      ["acc_finish", { goal: "x", completed: "done" }, "completed"],
    ];
    for (const [name, args, field] of cases) {
      const response = await call(request, meta, name, args);
      assert.equal(response.result.isError, true, `${name} accepted invalid ${field}`);
      assert.match(response.result.content[0].text, new RegExp(field));
    }
  });
});

test("work accepts exactly clear or a summary and mode", async t => {
  await withServer(t, async ({ request, meta }) => {
    const cleared = await call(request, meta, "acc_work", { clear: true });
    assert.equal(cleared.result.isError, undefined, cleared.result.content?.[0]?.text);
    assert.deepEqual(cleared.result.structuredContent, { cleared: true });

    for (const args of [{}, { summary: "x" }, { mode: "edit" },
      { clear: true, summary: "x", mode: "edit" }, { clear: false }]) {
      const response = await call(request, meta, "acc_work", args);
      assert.equal(response.result.isError, true, `acc_work accepted ${JSON.stringify(args)}`);
      assert.match(response.result.content[0].text, /arguments/);
    }
  });
});

test("claim requires the identifier for the selected action", async t => {
  await withServer(t, async ({ request, meta }) => {
    const acquired = await call(request, meta, "acc_claim",
      { action: "acquire", resource: "file:src/**" });
    assert.equal(acquired.result.isError, undefined, acquired.result.content?.[0]?.text);
    const claimId = JSON.parse(acquired.result.content[0].text).claimId;
    const renewed = await call(request, meta, "acc_claim", { action: "renew", claimId });
    assert.equal(renewed.result.isError, undefined, renewed.result.content?.[0]?.text);

    for (const args of [{ resource: "file:src/**" },
      { action: "acquire", claimId }, { action: "renew", resource: "file:src/**" }]) {
      const response = await call(request, meta, "acc_claim", args);
      assert.equal(response.result.isError, true, `acc_claim accepted ${JSON.stringify(args)}`);
      assert.match(response.result.content[0].text, /arguments/);
    }
  });
});

test("structuredContent is the value while text remains its JSON rendering", async t => {
  await withServer(t, async ({ request, meta }) => {
    const response = await call(request, meta, "acc_status", {});

    assert.equal(typeof response.result.structuredContent, "object");
    assert.deepEqual(response.result.structuredContent,
      JSON.parse(response.result.content[0].text));
  });
});

test("generic MCP message rejects answer and handoff as non-root kinds", async t => {
  await withServer(t, async ({ request, meta }) => {
    for (const kind of ["answer", "handoff"]) {
      const response = await call(request, meta, "acc_message",
        { to: [], subject: "x", body: "x", kind });
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /arguments\.kind/);
    }
  });
});
