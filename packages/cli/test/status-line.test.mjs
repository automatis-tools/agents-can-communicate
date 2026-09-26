import assert from "node:assert/strict";
import test from "node:test";

import { describeStatus } from "../src/main.mjs";

const status = (unretrieved = { queued: 0, offered: 0 }) => ({ protection: "none",
  counts: { live: 2, stale: 0, claims: 1, messages: 9, unretrieved } });

test("the status line names messages a transport took and nobody fetched", () => {
  assert.equal(describeStatus(status({ queued: 4, offered: 2 })),
    "2 live; 1 claim(s); protection none; 2 offered, not retrieved");
});

test("the status line stays as it was when every offer was fetched", () => {
  // Queued messages are no news on this line: a recipient that never had a
  // turn leaves them, and `--json` still carries the number.
  assert.equal(describeStatus(status({ queued: 4, offered: 0 })),
    "2 live; 1 claim(s); protection none");
});

test("a status from a store with no receipt counts reads as before", () => {
  const { counts: { unretrieved, ...counts }, ...rest } = status();

  assert.equal(describeStatus({ ...rest, counts }), "2 live; 1 claim(s); protection none");
});

// Messages waiting for a participant with no open session - Claude Code's
// /clear ended its conversation - are named, with the reason when known.
test("the status line names who has messages waiting and no open session", () => {
  const withOffline = { ...status(), participants: [
    { participantId: "claude_code-a", presence: "online", unretrieved: { queued: 0, offered: 0 } },
    { participantId: "claude_code-b", presence: "offline", endReason: "clear",
      unretrieved: { queued: 2, offered: 0 } },
    { participantId: "cli-c", presence: "offline", endReason: null,
      unretrieved: { queued: 1, offered: 0 } },
  ] };
  assert.equal(describeStatus(withOffline), "2 live; 1 claim(s); protection none; "
    + "waiting for a closed session: claude_code-b (cleared, 2), cli-c (1)");
});
