import assert from "node:assert/strict";
import test from "node:test";

import { MCP_CAPABILITIES, PUBLIC_TOOLS, RESOURCES } from "../src/tools.mjs";

const names = PUBLIC_TOOLS.map(tool => tool.name);

test("the model-facing surface is exactly this list", () => {
  // The surface stays small and high level: granular internal transitions are
  // reachable by adapters and stay out of here. Named rather than counted, so
  // a tool swapped for another still trips this.
  assert.deepEqual(names.sort(),
    ["acc_ack", "acc_claim", "acc_decide", "acc_finish", "acc_message", "acc_request",
      "acc_sync", "acc_task", "acc_work", "acc_workstream"]);
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

test("declared capabilities are truthful for a polling transport", () => {
  assert.equal(MCP_CAPABILITIES.delivery.polling, true);
  assert.equal(MCP_CAPABILITIES.delivery.activeNotification, false);
  assert.equal(MCP_CAPABILITIES.delivery.wakeDormantSession, false);
  for (const value of Object.values(MCP_CAPABILITIES.lifecycle)) assert.equal(value, false);
  for (const value of Object.values(MCP_CAPABILITIES.guards)) assert.equal(value, false);
  for (const value of Object.values(MCP_CAPABILITIES.execution)) assert.equal(value, false);
});

test("read-only resources are declared with stable uris", () => {
  const uris = RESOURCES.map(resource => resource.uri);

  assert.deepEqual(uris.sort(),
    ["acc://inbox", "acc://roster", "acc://snapshot", "acc://tasks", "acc://workstreams"]);
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
