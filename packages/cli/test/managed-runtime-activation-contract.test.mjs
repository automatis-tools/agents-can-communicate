import assert from "node:assert/strict";
import test from "node:test";

import { activationBlockerNotice, blocksActivation } from "../src/managed-runtime/activation.mjs";

test("a notice names the declared contract of each blocking hold", () => {
  const notice = activationBlockerNotice("0.4.5", [
    { pid: 4242, kinds: ["acc-claude-channel"], nativeBindings: 0, storeVersion: null,
      reason: "process_running" },
  ]);
  assert.match(notice, /PID 4242/);
  assert.match(notice, /contract unknown/);
});

test("a notice reports a differing contract as the reason", () => {
  const notice = activationBlockerNotice("0.5.0", [
    { pid: 77, kinds: ["native"], nativeBindings: 2, storeVersion: 6, reason: "process_running" },
  ]);
  assert.match(notice, /store contract 6/);
});

test("a hold blocks only when its declared contract is unknown or different", () => {
  assert.equal(blocksActivation({ storeVersion: 6 }, 6), false);
  assert.equal(blocksActivation({ storeVersion: 6 }, 7), true);
  assert.equal(blocksActivation({ storeVersion: null }, 6), true);
  // An incoming generation that declares nothing cannot be judged, so nothing
  // is allowed past. This is the pre-Task-1 generation case.
  assert.equal(blocksActivation({ storeVersion: 6 }, null), true);
});
