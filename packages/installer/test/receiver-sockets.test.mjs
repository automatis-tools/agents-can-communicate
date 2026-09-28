import assert from "node:assert/strict";
import test from "node:test";

import { receiverSockets } from "../src/receiver-sockets.mjs";

// A sandboxed sender has to be allowed every socket ACC can deliver to, whatever
// subset of clients one install names: `acc install --adapter codex` must still
// allow Claude Code's inbox. The installer composes what each adapter declares.

test("the union of every adapter's declaration, sorted and without duplicates", () => {
  const seen = [];
  const adapters = [
    { id: "b", inboundSockets: context => { seen.push(["b", context]); return ["/tmp/b", "/tmp/shared"]; } },
    { id: "none" },
    { id: "a", inboundSockets: () => ["/tmp/shared", "/tmp/a"] },
  ];
  const context = { home: "/h", env: { X: "1" } };
  assert.deepEqual(receiverSockets(adapters, context), ["/tmp/a", "/tmp/b", "/tmp/shared"]);
  assert.deepEqual(seen, [["b", context]], "each adapter reads the context it is given");
});

test("only absolute paths can be allowed", () => {
  const adapters = [{ id: "x", inboundSockets: () => ["relative/dir", "", null, 7, "/tmp/ok"] }];
  assert.deepEqual(receiverSockets(adapters, {}), ["/tmp/ok"]);
});

test("no receiving adapter means nothing to allow", () => {
  assert.deepEqual(receiverSockets([], {}), []);
  assert.deepEqual(receiverSockets([{ id: "x", inboundSockets: () => undefined }], {}), []);
});
