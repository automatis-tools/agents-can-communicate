import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { serve } from "../src/server.mjs";

test("raw invalid input is rejected without interrupting later stream chunks", async () => {
  let stdout = "";
  const output = new Writable({ write(chunk, encoding, done) {
    stdout += chunk;
    done();
  } });
  await serve({
    input: Readable.from(["null\n", "{\n", '{"jsonrpc":"2.0","method":42,"id":7}\n',
      '{"jsonrpc":"2.0","method":"ping","params":false,"id":8}\n',
      '{"jsonrpc":"2.0","method":"ping","id":9}\n']),
    output,
  });
  assert.deepEqual(stdout.trim().split("\n").map(line => JSON.parse(line)), [
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
    { jsonrpc: "2.0", id: 7, error: { code: -32600, message: "invalid request" } },
    { jsonrpc: "2.0", id: 8, error: { code: -32602, message: "invalid params" } },
    { jsonrpc: "2.0", id: 9, result: {} },
  ]);
});
