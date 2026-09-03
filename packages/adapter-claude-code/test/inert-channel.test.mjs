import assert from "node:assert/strict";
import test from "node:test";

import { createInertChannel } from "../src/channel.mjs";

// The Channel binary is spawned by every session that enables the plugin, not
// only by the ones ACC's shim launched with the development-channel flag. A
// session with no ACC binding has no endpoint to serve - but Claude still
// speaks MCP to the child it spawned, and a child that answers nothing is
// reported to the user as a server that failed to connect. So the unbound case
// is a complete, honest MCP server: it finishes the handshake, advertises no
// channel it cannot serve, and offers no tools.
test("a client with no bound ACC session still gets a complete MCP handshake", async () => {
  const written = [];
  const channel = createInertChannel({ write: payload => written.push(payload) });
  const send = message => channel.handleLine(JSON.stringify(message));

  await send({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05" } });

  const initialize = written.find(message => message.id === 1);
  assert.notEqual(initialize, undefined,
    "an unbound channel must answer initialize, or Claude reports it as failed to connect");
  assert.equal(initialize.result.protocolVersion, "2024-11-05");
  assert.equal(initialize.error, undefined);
});

test("an unbound channel never advertises a claude/channel it cannot serve", async () => {
  const written = [];
  const channel = createInertChannel({ write: payload => written.push(payload) });

  await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05" } }));

  const { capabilities } = written.find(message => message.id === 1).result;
  assert.equal(capabilities?.experimental?.["claude/channel"], undefined,
    "declaring a channel with no endpoint behind it points Claude at nothing");
});

test("an unbound channel offers no tools and stays answerable", async () => {
  const written = [];
  const channel = createInertChannel({ write: payload => written.push(payload) });

  await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }));

  assert.deepEqual(written.find(message => message.id === 2).result.tools, [],
    "no session is bound, so acc_reply and acc_ack would have nothing to write to");
  assert.deepEqual(written.find(message => message.id === 3).result, {});
});

test("a notification is not answered and a bad line does not end the server", async () => {
  const written = [];
  const channel = createInertChannel({ write: payload => written.push(payload) });

  await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.deepEqual(written, [], "a notification carries no id and takes no reply");

  await channel.handleLine("{not json");
  await channel.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }));
  assert.deepEqual(written.at(-1).result, {}, "the server keeps answering after a bad line");
});
