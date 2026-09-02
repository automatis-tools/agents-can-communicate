import assert from "node:assert/strict";
import test from "node:test";

import { MCP_CAPABILITIES, PUBLIC_TOOLS, RESOURCES } from "../src/tools.mjs";

const names = PUBLIC_TOOLS.map(tool => tool.name);

test("the model-facing surface is exactly this list", () => {
  // The surface stays small and high level: granular internal transitions are
  // reachable by adapters and stay out of here. Named rather than counted, so
  // a tool swapped for another still trips this.
  assert.deepEqual(names.sort(),
    ["acc_ack", "acc_claim", "acc_finish", "acc_inbox", "acc_message", "acc_release",
      "acc_reply", "acc_request", "acc_status", "acc_sync", "acc_work"]);
});

test("every tool declares a strict 2020-12 input schema", () => {
  for (const tool of PUBLIC_TOOLS) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} is not an object schema`);
    assert.equal(tool.inputSchema.additionalProperties, false,
      `${tool.name} accepts unknown properties`);
    assert.equal(Array.isArray(tool.inputSchema.required), true);
    for (const required of tool.inputSchema.required) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties, required),
        true, `${tool.name} requires ${required} but does not describe it`);
    }
  }
});

test("every tool description states the polling semantics honestly", () => {
  for (const tool of PUBLIC_TOOLS) {
    assert.match(tool.description, /poll/i,
      `${tool.name} does not tell the model that delivery is polled`);
    assert.equal(tool.description.length > 40, true, `${tool.name} description is too thin`);
  }
});

test("capabilities MCP lacks are only ever mentioned in the negative", () => {
  // A tool description is the only contract the model sees, so claiming
  // protection MCP cannot deliver is worse than offering nothing. Naming these
  // capabilities is useful - denying them is the point - so each mention must
  // be negated rather than absent.
  const claims = /\b(guarantee\w*|wake\w*|push\w*|block\w*|prevent\w*)\b/gi;
  const negated = /\b(no|not|never|without|cannot|rather than)\b[^.]{0,40}$/i;

  for (const tool of PUBLIC_TOOLS) {
    for (const match of tool.description.matchAll(claims)) {
      const preceding = tool.description.slice(0, match.index);
      assert.match(preceding, negated,
        `${tool.name} mentions "${match[0]}" without denying it: ...${preceding.slice(-60)}`);
    }
  }
});

test("manual MCP polling does not claim an adapter delivery capability", () => {
  assert.deepEqual(MCP_CAPABILITIES.delivery,
    { nextTurn: false, livePush: false, replyRoute: false });
  for (const value of Object.values(MCP_CAPABILITIES.lifecycle)) assert.equal(value, false);
  for (const value of Object.values(MCP_CAPABILITIES.guards)) assert.equal(value, false);
  assert.equal(Object.hasOwn(MCP_CAPABILITIES, "execution"), false);
});

test("resources are declared with stable uris", () => {
  const uris = RESOURCES.map(resource => resource.uri);

  assert.deepEqual(uris.sort(),
    ["acc://inbox", "acc://roster", "acc://snapshot"]);
  for (const resource of RESOURCES) {
    assert.equal(resource.mimeType, "application/json");
    assert.equal(typeof resource.description, "string");
  }
});

test("acc_sync exposes the full scope so any session can answer for the workspace", () => {
  const sync = PUBLIC_TOOLS.find(tool => tool.name === "acc_sync");

  assert.deepEqual(sync.inputSchema.properties.scope.enum, ["delta", "full"]);
  assert.match(sync.description, /whole workspace|full/i);
});

test("no tool takes a session handle: identity comes from configuration", () => {
  // Approved 2026-08-16. The protocol is stateless, so the session is derived
  // from the server's own launch configuration rather than passed by the model,
  // which cannot be trusted to carry a handle it does not understand.
  for (const tool of PUBLIC_TOOLS) {
    for (const property of Object.keys(tool.inputSchema.properties)) {
      assert.doesNotMatch(property, /^(sessionId|generation)$/,
        `${tool.name} asks the model for ${property}`);
    }
  }
});

test("send tools expose idempotency and only the v0.2 message semantics", () => {
  const byName = name => PUBLIC_TOOLS.find(tool => tool.name === name).inputSchema.properties;
  for (const name of ["acc_message", "acc_request", "acc_reply", "acc_finish"]) {
    assert.equal(byName(name).clientMessageId.type, "string", `${name} has no retry key`);
  }

  assert.deepEqual(byName("acc_message").kind.enum,
    ["note", "question", "request", "decision"]);
  assert.deepEqual(byName("acc_message").obligation.enum, ["none", "acknowledge", "reply"]);
  for (const removed of ["type", "priority", "requiresAck", "workstreamId"]) {
    assert.equal(Object.hasOwn(byName("acc_message"), removed), false,
      `acc_message still exposes ${removed}`);
  }
  assert.equal(Object.hasOwn(byName("acc_ack"), "state"), false,
    "the model can still forge a transport-owned receipt state");
});

test("intent publishing has no legacy orchestration handle", () => {
  const work = PUBLIC_TOOLS.find(tool => tool.name === "acc_work");

  assert.equal(Object.hasOwn(work.inputSchema.properties, "workstreamId"), false);
});

test("request describes the reply obligation it actually creates", () => {
  const request = PUBLIC_TOOLS.find(tool => tool.name === "acc_request");

  assert.match(request.description, /reply-required/);
  assert.doesNotMatch(request.description, /acknowledged message/);
});
