import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createCodexAdapter } from "../src/adapter.mjs";

test("the Codex control socket is declared for sandboxed senders", () => {
  const adapter = createCodexAdapter();
  assert.deepEqual(adapter.inboundSockets({ home: "/h", codexHome: "/c" }),
    [path.join("/c", "app-server-control", "app-server-control.sock")]);
  assert.deepEqual(adapter.inboundSockets({ home: "/h" }),
    [path.join("/h", ".codex", "app-server-control", "app-server-control.sock")]);
});
