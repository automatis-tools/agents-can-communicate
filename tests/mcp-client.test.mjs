import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeFixture } from "./helpers/fixture-cleanup.mjs";
import { connectMcp } from "./helpers/mcp-client.mjs";

async function client(t, source, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-mcp-client-probe-"));
  const binary = path.join(root, "server.mjs");
  await writeFile(binary, source);
  const connected = connectMcp({ cwd: root, dataHome: root, binary, ...options });
  t.after(async () => {
    connected.child.kill("SIGKILL");
    await connected.closed;
    // The root is the server's working directory and its descendant's. On Windows a
    // process killed a moment ago can still hold it (EBUSY, windows-latest on #361).
    await removeFixture(root);
  });
  return connected;
}

const readRequests = `
  import { createInterface } from "node:readline";
  const input = createInterface({ input: process.stdin });
  const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
`;

// FIFO routing returns the notification or assigns the second response to the
// first caller. Explicit IDs let a real peer answer in either order.
test("MCP requests match response IDs and ignore notifications", async t => {
  const c = await client(t, `${readRequests}
    const requests = [];
    input.on("line", line => {
      requests.push(JSON.parse(line));
      if (requests.length === 2) {
        send({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
        for (const request of requests.toReversed())
          send({ jsonrpc: "2.0", id: request.id, result: request.method });
      }
    });
  `);
  const [first, second] = await Promise.all([c.request("first", {}, 11), c.request("second", {}, 22)]);
  assert.deepEqual([first.id, first.result, second.id, second.result], [11, "first", 22, "second"]);
  assert.equal(await c.close(), 0);
});

async function bounded(pending, budget = 1000) {
  let timer;
  try {
    return await Promise.race([pending.then(() => "resolved", error => error.message),
      new Promise(resolve => { timer = setTimeout(resolve, budget, "outer watchdog"); })]);
  } finally { clearTimeout(timer); }
}

test("automatic MCP request IDs do not collide with an explicit pending ID", async t => {
  const c = await client(t, `${readRequests}
    input.on("line", line => {
      const request = JSON.parse(line);
      send({ jsonrpc: "2.0", id: request.id, result: request.method });
    });
  `);
  const replies = await Promise.allSettled([c.request("explicit", {}, 1), c.request("automatic", {})]);
  assert.deepEqual(replies.map(reply => reply.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(replies.map(reply => reply.value.id), [1, 2]);
  assert.equal(await c.close(), 0);
});

test("MCP requests reject a silent peer with a deadline", async t => {
  const c = await client(t, `${readRequests} input.on("line", () => {});`, { requestTimeoutMs: 100 });
  assert.match(await bounded(c.request("silent", {})), /timed out.*silent/);
  assert.equal(await c.close(), 0);
});

test("MCP malformed stdout rejects pending requests", async t => {
  const c = await client(t, `${readRequests} input.once("line", () => process.stdout.write("bad json\\n"));`);
  const errors = await Promise.all([bounded(c.request("malformed", {}, 1)),
    bounded(c.request("also pending", {}, 2))]);
  for (const error of errors) assert.match(error, /invalid JSON|not valid JSON/);
});

test("MCP exit rejects a request rather than waiting forever", async t => {
  const c = await client(t, `${readRequests} input.on("line", () => {
    process.stderr.write("probe exit"); process.exit(7);
  });`);
  const error = await bounded(c.request("exit", {}));
  assert.match(error, /exited/);
  assert.match(error, /probe exit/);
  assert.match(error, /exit/);
  assert.equal(await c.closed, 7);
});

test("MCP close fails and stops a peer that ignores stdin EOF", async t => {
  const c = await client(t, `${readRequests}
    input.on("line", request => send({ id: JSON.parse(request).id, result: true }));
    input.on("close", () => setInterval(() => {}, 1000));
  `, { closeTimeoutMs: 100 });
  await c.request("ready", {});
  assert.match(await bounded(c.close()), /timed out.*clos/);
  assert.notEqual(c.child.signalCode ?? c.child.exitCode, null, "close must stop its owned child");
});

// ChildProcess.close waits for inherited stdio even after its own process exits.
// A descendant must not extend the cleanup deadline by keeping those pipes open.
test("MCP close remains bounded when a descendant inherits its stdout and stderr", async t => {
  let descendantPid;
  t.after(() => {
    if (descendantPid === undefined) return;
    try { process.kill(descendantPid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  const c = await client(t, `${readRequests}
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    const descendant = spawn(process.execPath, ["--input-type=module", "--eval",
      'const timer = setInterval(() => {}, 1000); process.once("disconnect", () => {'
      + 'clearInterval(timer); setTimeout(() => process.exit(0), 1500); }); process.send("ready");'],
      { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const ready = once(descendant, "message");
    input.on("line", async request => {
      await ready;
      send({ id: JSON.parse(request).id, result: descendant.pid });
    });
    input.on("close", () => setInterval(() => {}, 1000));
  `, { closeTimeoutMs: 100 });
  descendantPid = (await c.request("ready", {})).result;
  assert.equal(Number.isInteger(descendantPid), true, "the probe must identify its owned descendant");

  const error = await bounded(c.close(), 500);
  assert.match(error, /timed out.*clos/, "inherited pipes extended the shutdown deadline");
  assert.notEqual(c.child.signalCode ?? c.child.exitCode, null, "the direct server must have exited");
  for (const stream of [c.child.stdin, c.child.stdout, c.child.stderr]) {
    assert.equal(stream.destroyed, true, "owned stdio must not remain open after timeout");
  }
});
