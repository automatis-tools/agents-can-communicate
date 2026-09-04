import assert from "node:assert/strict";
import test from "node:test";

import { resolveSession } from "../../bin/acc-claude-channel.mjs";

/**
 * A Channel must serve the session that spawned it, and no other.
 *
 * Measured on two real 2.1.259 sessions in one workspace. The second client's
 * Channel started while its own SessionStart hook was still writing its
 * binding, so the only binding it could see was the *first* session's. The
 * lookup then fell back to "if exactly one session is live, it must be mine"
 * and adopted it. Both Channels ended up registering an endpoint under the
 * first client's pid, and the consequences were both observed:
 *
 *  - `bindNativeSession` requires exactly one registration per client pid, so
 *    two of them refused the handshake and the session that had been receiving
 *    live messages went back to the durable inbox;
 *  - worse than the outage, an `acc_reply` from the second window would have
 *    been recorded as the first session's answer. A reply that names the wrong
 *    author is not a delivery bug, it is a false record.
 *
 * The Channel is spawned by its client, so its own ancestry names that client.
 * That fact cannot be raced, which is why ownership is decided by it and never
 * by how many sessions happen to be visible at the time.
 */
const binding = (accSessionId, clientPid, harnessSessionId) => ({ accSessionId, clientPid,
  harnessSessionId, generation: `generation_for_${accSessionId}` });

const serviceWith = (...liveSessionIds) => ({
  collectStatus: async () => ({ participants: liveSessionIds
    .map(sessionId => ({ sessionId, presence: "online" })) }),
});

const resolve = ({ bindings, live, ownClientPid, env = {} }) => resolveSession({
  runtimeDir: "/unused", env, ownClientPid,
  service: serviceWith(...live),
  listBindings: async () => bindings,
});

test("a channel refuses a live binding that belongs to another client process", async () => {
  const theirs = binding("session_first", 81053, "harness-first");

  const session = await resolve({ bindings: [theirs], live: ["session_first"],
    ownClientPid: 95442 });

  assert.equal(session, null,
    "the only visible session was somebody else's, and adopting it publishes this "
    + "session's endpoint under their identity");
});

test("a channel binds the session running in its own client process", async () => {
  const bindings = [binding("session_first", 81053, "harness-first"),
    binding("session_second", 95442, "harness-second")];

  const session = await resolve({ bindings, live: ["session_first", "session_second"],
    ownClientPid: 95442 });

  assert.equal(session?.sessionId, "session_second");
  assert.equal(session?.clientPid, 95442);
  assert.equal(session?.generation, "generation_for_session_second");
});

// Being the only session on the machine is the case where the old fallback
// looked harmless, and it is still not what decides ownership: the pid does.
test("being the only live session is not what makes a binding this channel's", async () => {
  const theirs = binding("session_first", 81053, "harness-first");

  assert.equal(await resolve({ bindings: [theirs], live: ["session_first"],
    ownClientPid: 4242 }), null);
  assert.equal((await resolve({ bindings: [theirs], live: ["session_first"],
    ownClientPid: 81053 }))?.sessionId, "session_first");
});

test("a channel that cannot name its own client serves nobody", async () => {
  const theirs = binding("session_first", 81053, "harness-first");

  const session = await resolve({ bindings: [theirs], live: ["session_first"],
    ownClientPid: null });

  assert.equal(session, null,
    "unknown ownership must fail closed; guessing is how the wrong session gets adopted");
});

test("an offline session's binding is not adopted even from the right client", async () => {
  const mine = binding("session_gone", 95442, "harness-gone");

  const session = await resolve({ bindings: [mine], live: [], ownClientPid: 95442 });

  assert.equal(session, null, "a binding whose session is no longer live names nothing to serve");
});

// One client process can outlive a session and start another - a reused pid
// with two live bindings. The harness session id the client exports is what
// separates them, and without it the channel still refuses rather than guesses.
test("two live bindings on one client pid are separated by the exported session id", async () => {
  const bindings = [binding("session_old", 95442, "harness-old"),
    binding("session_new", 95442, "harness-new")];

  assert.equal((await resolve({ bindings, live: ["session_old", "session_new"],
    ownClientPid: 95442, env: { CLAUDE_CODE_SESSION_ID: "harness-new" } }))?.sessionId,
  "session_new");
  assert.equal(await resolve({ bindings, live: ["session_old", "session_new"],
    ownClientPid: 95442 }), null,
  "with nothing to tell them apart the channel must not pick one");
});
