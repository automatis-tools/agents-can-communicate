import { AccError, EXIT } from "@agents-can-communicate/protocol";

// A bounded wait on the inbox (#147). It watches the event log, which is
// append-only and read without the writer lock, and runs one ordinary inbox
// read when the wait ends. A store transaction on every poll would take the
// lock that hooks share under a five-second budget, thirty times a minute.

export const INBOX_WAIT_MAX_MS = 600_000;
const POLL_MS = 500;
const PAGE = 200;

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function createInboxWait(ports, sessions, inbox) {
  const { store, clock } = ports;
  const sleep = ports.sleep ?? pause;

  // Where a reader that read everything would stand. A store that cannot say so
  // directly is read to the end, which costs one pass over its log.
  async function headCursor(workspaceId) {
    if (typeof store.eventCursor === "function") return store.eventCursor(workspaceId);
    for (let cursor = null; ;) {
      const page = await store.eventsSince(workspaceId, cursor, PAGE);
      if (page.events.length === 0) return page.cursor;
      cursor = page.cursor;
    }
  }

  // Whether a message for this participant was recorded after the cursor, and
  // where reading stopped. Retention may trim what the wait already read; a
  // cursor below the trimmed boundary still reads every event that remains.
  async function readSince(workspaceId, participantId, cursor) {
    for (;;) {
      const page = await store.eventsSince(workspaceId, cursor, PAGE);
      if (page.events.some(event => event.type === "message.recorded"
        && event.payload?.recipientParticipantIds?.includes(participantId))) {
        return { arrived: true, cursor: page.cursor };
      }
      if (page.events.length < PAGE) return { arrived: false, cursor: page.cursor };
      cursor = page.cursor;
    }
  }

  async function waitForInbox(input) {
    const waitMs = input.waitMs;
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > INBOX_WAIT_MAX_MS) {
      throw new AccError(EXIT.USAGE, `the wait must be 1 to ${INBOX_WAIT_MAX_MS} milliseconds`,
        { waitMs });
    }
    const session = (await sessions.locateSession(input.sessionId, input.workspaceId))?.record;
    if (session == null || session.state !== "open" || session.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, "cannot wait on the inbox from this session generation",
        { sessionId: input.sessionId });
    }
    const started = Date.parse(clock.now());
    const deadline = started + waitMs;
    let cursor = await headCursor(session.workspaceId);
    let arrived = false;
    for (;;) {
      ({ arrived, cursor } = await readSince(session.workspaceId, session.participantId, cursor));
      const left = deadline - Date.parse(clock.now());
      if (arrived || left <= 0) break;
      await sleep(Math.min(POLL_MS, left));
    }
    const page = await inbox.listInbox({ sessionId: input.sessionId, generation: input.generation,
      workspaceId: input.workspaceId, limit: input.limit });
    return { ...page, wait: { arrived, waitedMs: Date.parse(clock.now()) - started } };
  }

  return { waitForInbox };
}
