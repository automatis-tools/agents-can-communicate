import assert from "node:assert/strict";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openJsonRpcPeer } from "../../scripts/spikes/json-rpc-peer.mjs";

const fixtureServer = fileURLToPath(import.meta.url);
const isFixtureServer = process.argv.includes("--fixture-server");

if (isFixtureServer) serveFixture();
else test("the peer correlates responses while retaining notifications", async () => {
  const peer = openJsonRpcPeer({
    command: process.execPath,
    args: [fixtureServer, "--fixture-server"],
    timeoutMs: 500,
  });

  try {
    const [first, second] = await Promise.all([
      peer.request("thread/list", { limit: 1 }),
      peer.request("thread/resume", { threadId: "thread_existing" }),
    ]);

    assert.deepEqual(first, { data: ["thread_existing"] });
    assert.deepEqual(second, { thread: { id: "thread_existing" } });
    assert.equal(
      peer.notifications.some((item) => item.method === "turn/started"),
      true,
    );
  } finally {
    await peer.close();
  }
});

if (!isFixtureServer) test("the peer times out each unanswered request", async () => {
  const peer = openJsonRpcPeer({
    command: process.execPath,
    args: [fixtureServer, "--fixture-server"],
    timeoutMs: 25,
  });

  try {
    await assert.rejects(peer.request("fixture/ignore", {}), /timed out after 25ms/);
  } finally {
    await peer.close();
  }
});

function serveFixture() {
  const pending = [];
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "fixture/ignore") return;

    pending.push(message);
    if (pending.length !== 2) return;
    const [first, second] = pending;
    write({ method: "turn/started", params: { threadId: "thread_existing" } });
    write({ id: second.id, result: { thread: { id: second.params.threadId } } });
    write({ id: first.id, result: { data: ["thread_existing"] } });
  });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
