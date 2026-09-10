import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_QUEUE_MINIMUM } from "../src/adapter.mjs";
import { verifyReceiver } from "../src/native-delivery.mjs";

const peer = serverVersion => ({ serverVersion });
const endpoint = { threadId: "thread-1", cwd: "/project", clientVersion: "0.153.4" };

test("a service upgraded above the minimum keeps serving an existing binding", async () => {
  assert.equal(CODEX_QUEUE_MINIMUM, "0.152.1");
  const result = await verifyReceiver(peer("0.154.0"), endpoint, {
    probe: async () => ({ supported: true, serverVersion: "0.154.0", reasonCode: null }),
    locate: async () => ({ found: true }),
  });
  assert.equal(result, null);
});

test("a service downgraded below the minimum stops serving it", async () => {
  const result = await verifyReceiver(peer("0.151.0"), endpoint, {
    probe: async () => ({ supported: true, serverVersion: "0.151.0", reasonCode: null }),
    locate: async () => ({ found: true }),
  });
  assert.equal(result, "handshake_version_mismatch");
});
