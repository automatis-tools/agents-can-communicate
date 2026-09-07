import assert from "node:assert/strict";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

test("installed failed hooks report degraded coordination without reflecting their input", async t => {
  const packed = await createPackedAcc(t);
  const marker = "private-hook-payload-do-not-echo";
  for (const [adapter, payload] of [["missing_adapter", { prompt: marker }],
    ["claude_code", { hook_event_name: "unsupported", prompt: marker }]]) {
    const result = await packed.hook(adapter, payload);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /coordination.*unavailable/i);
    assert.ok(Buffer.byteLength(result.stderr) <= 512);
    assert.equal(result.stderr.includes(marker), false);
  }
});
