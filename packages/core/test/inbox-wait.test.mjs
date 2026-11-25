import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

// `acc inbox --wait` (#147). It returns for a message recorded after it
// started, or when its time is up - never for what was already waiting, which
// would turn every wait into an immediate return, as polling is now. Time is a
// fake clock that each sleep advances, so a ten-minute wait takes no time.

const WORKSPACE = "workspace_inbox_wait";

function fixture() {
  const clock = createFakeClock("2026-11-25T05:00:00.000Z");
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const sleeps = [];
  let onSleep = async () => {};
  const sleep = async milliseconds => {
    sleeps.push(milliseconds);
    clock.advance(milliseconds);
    await onSleep(sleeps.length);
  };
  const service = createCoordinationService({ store, clock, ids, sleep });
  return { clock, ids, store, service, sleeps, sleep, during: callback => { onSleep = callback; } };
}

const opening = participantId => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000 });
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

async function peers(service) {
  return { sender: await service.openSession(opening("sender")),
    recipient: await service.openSession(opening("recipient")),
    other: await service.openSession(opening("other")) };
}

let sent = 0;
const send = (service, from, to, subject) => service.sendMessage({ ...owner(from),
  clientMessageId: `client_${sent += 1}`, toParticipantIds: [to], kind: "question",
  obligation: "reply", subject, body: subject });

test("a message recorded during the wait ends it, and the page lists it", async () => {
  const { service, sleeps, during } = fixture();
  const { sender, recipient } = await peers(service);
  during(async count => { if (count === 3) await send(service, sender, "recipient", "verdict"); });

  const result = await service.waitForInbox({ ...owner(recipient), waitMs: 60_000 });

  assert.equal(result.wait.arrived, true);
  assert.equal(result.wait.waitedMs, 1_500);
  assert.deepEqual(sleeps, [500, 500, 500]);
  assert.deepEqual(result.items.map(item => item.message.subject), ["verdict"]);
});

test("a message that was already waiting does not end the wait", async () => {
  const { service, sleeps } = fixture();
  const { sender, recipient } = await peers(service);
  await send(service, sender, "recipient", "old request");

  const result = await service.waitForInbox({ ...owner(recipient), waitMs: 2_000 });

  assert.equal(result.wait.arrived, false);
  assert.equal(result.wait.waitedMs, 2_000);
  assert.equal(sleeps.length, 4);
  // The page is still the whole inbox: the old request is listed, as plain inbox lists it.
  assert.deepEqual(result.items.map(item => item.message.subject), ["old request"]);
});

test("a message for another participant does not end the wait", async () => {
  const { service, during } = fixture();
  const { sender, recipient } = await peers(service);
  during(async count => { if (count === 1) await send(service, sender, "other", "not yours"); });

  const result = await service.waitForInbox({ ...owner(recipient), waitMs: 1_200 });

  assert.equal(result.wait.arrived, false);
  assert.equal(result.wait.waitedMs, 1_200);
  assert.deepEqual(result.items, []);
});

test("the wait changes no receipt and records no event", async () => {
  const { service, store, during } = fixture();
  const { sender, recipient } = await peers(service);
  during(async count => { if (count === 1) await send(service, sender, "recipient", "news"); });
  const before = await store.eventsSince(WORKSPACE, null, 1_000);

  const result = await service.waitForInbox({ ...owner(recipient), waitMs: 5_000 });
  const after = await store.eventsSince(WORKSPACE, null, 1_000);

  assert.equal(result.items[0].receipt.state, "queued");
  assert.deepEqual(after.events.map(event => event.type),
    [...before.events.map(event => event.type), "message.recorded"]);
});

test("a log trimmed during the wait is followed from its boundary", async () => {
  const { service, store, during } = fixture();
  const { sender, recipient } = await peers(service);
  during(async count => {
    // Everything the wait has read so far goes, as retention trims it.
    if (count === 1) await store.trimHistory((await store.eventsSince(WORKSPACE, null, 1_000)).cursor);
    if (count === 2) await send(service, sender, "recipient", "after the trim");
  });

  const result = await service.waitForInbox({ ...owner(recipient), waitMs: 5_000 });

  assert.equal(result.wait.arrived, true);
  assert.equal(result.wait.waitedMs, 1_000);
  assert.deepEqual(result.items.map(item => item.message.subject), ["after the trim"]);
});

test("a wait from a closed or replaced session is refused before it waits", async () => {
  const { service, sleeps } = fixture();
  const { recipient } = await peers(service);
  await assert.rejects(service.waitForInbox({ sessionId: recipient.sessionId,
    generation: "generation_stale", waitMs: 1_000 }), error => error.code === EXIT.CONFLICT);
  for (const waitMs of [0, 600_001, 1.5, "60"]) {
    await assert.rejects(service.waitForInbox({ ...owner(recipient), waitMs }),
      error => error.code === EXIT.USAGE);
  }
  assert.deepEqual(sleeps, []);
});

test("a burst longer than one page of events is read to its end", async () => {
  const { service, during } = fixture();
  const { sender, recipient } = await peers(service);
  during(async count => {
    if (count !== 1) return;
    for (let index = 0; index < 210; index += 1) await send(service, sender, "other", `busy ${index}`);
    await send(service, sender, "recipient", "yours, after the burst");
  });

  const result = await service.waitForInbox({ ...owner(recipient), waitMs: 1_000 });

  assert.equal(result.wait.arrived, true);
  assert.equal(result.wait.waitedMs, 500);
});

test("the wait's time starts once its starting point is read", async () => {
  const { service, store, clock, ids, sleeps, sleep } = fixture();
  const { recipient } = await peers(service);
  // Reading the starting point takes time on a real store; here it takes ten
  // seconds of fake time. Counting it would leave a 2 s wait no time at all.
  let reads = 0;
  const slowStart = { ...store, eventsSince: async (...args) => {
    if ((reads += 1) === 1) clock.advance(10_000);
    return store.eventsSince(...args);
  } };
  const waiting = createCoordinationService({ store: slowStart, clock, ids, sleep });

  const result = await waiting.waitForInbox({ ...owner(recipient), waitMs: 2_000 });

  assert.equal(result.wait.arrived, false);
  assert.equal(result.wait.waitedMs, 2_000);
  assert.deepEqual(sleeps, [500, 500, 500, 500]);
});
