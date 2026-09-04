import assert from "node:assert/strict";
import test from "node:test";

import { resolveWithin } from "../../bin/acc-claude-channel.mjs";

/**
 * The Channel races the hook that gives it something to bind to.
 *
 * Claude spawns this MCP child while the SessionStart hook is still running:
 * measured on a real 2.1.259 session, the client started at 23:23:37 and both
 * the child and the hook's binding landed in the same second, 23:23:39. A
 * single lookup therefore wins or loses a sub-second race - and losing it is
 * permanent, because a Channel that resolves no session serves the unbound
 * server for the life of that session. Native delivery then activates or does
 * not, per launch, with nothing in the record saying which happened.
 *
 * So the lookup is retried until the binding appears. Bounded, because an
 * ordinary session with no ACC binding must still get its handshake rather than
 * a child that waits forever.
 */
test("the channel waits for a binding the hook is still writing", async () => {
  let calls = 0;
  const resolve = async () => (calls++ < 2
    ? null
    : { sessionId: "session_x", generation: "generation_x", clientPid: 5 });
  const slept = [];

  const session = await resolveWithin({ resolve, deadline: 1_000, now: () => 0,
    sleep: ms => { slept.push(ms); return Promise.resolve(); } });

  assert.equal(session?.clientPid, 5, "the binding that arrived late must still be used");
  assert.equal(calls, 3, "it retried rather than giving up on the first miss");
  assert.deepEqual(slept, [100, 100], "it waited between attempts instead of spinning");
});

test("the wait is bounded, so an unbound session is not held open forever", async () => {
  let calls = 0;
  let clock = 0;

  const session = await resolveWithin({ resolve: async () => { calls += 1; return null; },
    deadline: 300, now: () => clock, sleep: ms => { clock += ms; return Promise.resolve(); } });

  assert.equal(session, null, "no binding ever appeared, so the answer is nobody");
  assert.ok(calls > 1 && calls <= 6, `bounded retries, got ${calls}`);
});

test("a binding without a client pid is not accepted as bound", async () => {
  let clock = 0;
  const session = await resolveWithin({
    resolve: async () => ({ sessionId: "session_x", generation: "generation_x" }),
    deadline: 200, now: () => clock, sleep: ms => { clock += ms; return Promise.resolve(); } });

  assert.equal(session, null,
    "the channel binds an exact process; a binding with no pid names no process");
});
