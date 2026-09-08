import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);

test("installed acc-mcp rejects invalid requests and keeps serving", async t => {
  const packed = await createPackedAcc(t);
  const invalidRequests = [
    null, false, 42, "request", [], {},
    { method: "ping", id: 1 },
    { jsonrpc: "1.0", method: "ping", id: 1 },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", method: 42, id: 1 },
    { jsonrpc: "2.0", method: "ping", id: false },
    { jsonrpc: "2.0", method: "ping", id: {} },
    { jsonrpc: "2.0", method: "ping", id: [] },
    { jsonrpc: "2.0", method: 42, id: "bad-method" },
    [{ jsonrpc: "2.0", method: "ping", id: 1 }],
  ];

  async function exchange(lines) {
    const pending = run(process.execPath, [packed.mcpBin], {
      cwd: packed.project,
      env: { ...packed.env, ACC_MCP_WORKSPACE: packed.project },
      timeout: 10_000,
    });
    pending.child.stdin.end(`${lines.join("\n")}\n`);
    const { stdout } = await pending;
    return stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  }

  for (const invalid of invalidRequests) {
    await t.test(JSON.stringify(invalid), async () => {
      const responses = await exchange([
        JSON.stringify(invalid),
        JSON.stringify({ jsonrpc: "2.0", method: "ping", id: "after-invalid" }),
      ]);
      const id = typeof invalid?.id === "string" || typeof invalid?.id === "number"
        ? invalid.id : null;
      assert.deepEqual(responses, [
        { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } },
        { jsonrpc: "2.0", id: "after-invalid", result: {} },
      ]);
    });
  }

  await t.test("invalid params are rejected with the request id after initialization", async () => {
    const requests = [
      { jsonrpc: "2.0", method: "initialize", id: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {},
        clientInfo: { name: "invalid-params-test", version: "1.0.0" },
      } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ];
    const expected = [];
    for (const method of ["initialize", "ping", "tools/call", "resources/read"]) {
      for (const params of [null, false, 42, "bad"]) {
        const id = `${method}-${JSON.stringify(params)}`;
        requests.push({ jsonrpc: "2.0", method, params, id },
          { jsonrpc: "2.0", method: "ping", id: `${id}-after` });
        expected.push(
          { jsonrpc: "2.0", id, error: { code: -32602, message: "invalid params" } },
          { jsonrpc: "2.0", id: `${id}-after`, result: {} },
        );
      }
    }
    const [initialized, ...responses] = await exchange(requests.map(value => JSON.stringify(value)));
    assert.equal(initialized.result.protocolVersion, "2025-11-25");
    assert.deepEqual(responses, expected);
  });

  await t.test("parse errors are followed by a valid response", async () => {
    assert.deepEqual(await exchange([
      "{",
      JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 0 }),
    ]), [
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { jsonrpc: "2.0", id: 0, result: {} },
    ]);
  });

  await t.test("valid notifications get no reply", async () => {
    assert.deepEqual(await exchange([
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", method: "ping", id: null }),
      JSON.stringify({ jsonrpc: "2.0", method: "ping", params: false }),
      JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {}, id: 0 }),
    ]), [{ jsonrpc: "2.0", id: 0, result: {} }]);
  });
});
