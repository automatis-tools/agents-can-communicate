import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

test("an installed solo inbox accepts its valid ephemeral owner", async t => {
  const packed = await createPackedAcc(t);
  const session = await packed.acc(["attach", "--participant", "solo"]);
  const inbox = await packed.acc(["inbox", "--session", session.sessionId,
    "--generation", session.generation]);
  assert.deepEqual(inbox, []);
  const state = await packed.acc(["sync", "--scope", "full"]);
  assert.equal(state.snapshot.workspace, null);
});

// Schedule a real close/replacement after the installed core reads ownership,
// but before its filesystem transaction begins. No transaction or record is
// mocked: the wrapper only selects an otherwise timing-dependent interleaving.
test("installed inbox operations cannot outlive their owner generation", async t => {
  const packed = await createPackedAcc(t);
  const load = name => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", "index.mjs")).href);
  const { createCoordinationService } = await load("core");
  const { openFilesystemStore } = await load("storage-filesystem");
  const { createId } = await load("protocol");
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind) };
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

  for (const operation of ["readInbox", "acknowledgeMessage"]) {
    for (const transition of ["close", "replace"]) {
      await t.test(`${operation} refuses a ${transition} before its commit`, async () => {
        const workspaceId = "workspace_inbox_race";
        const store = await openFilesystemStore({ root: path.join(packed.root,
          `${operation}-${transition}`), workspaceId, clock, ids });
        const service = createCoordinationService({ store, clock, ids });
        const opening = participantId => ({ participantId, workspaceId,
          harness: "fixture", heartbeatCadenceMs: 60_000 });
        const sender = await service.openSession(opening("sender"));
        const reader = await service.openSession(opening("reader"));
        const message = await service.sendMessage({ ...owner(sender),
          clientMessageId: "client_request", toParticipantIds: ["reader"],
          kind: "request", obligation: "reply", subject: "Review", body: "Pending work" });
        let successor, checkpoint, eventsBefore;
        let armed = true;
        const racingStore = { ...store, transaction: async (callback, options) => {
          if (armed) {
            armed = false;
            await service.closeSession(owner(reader));
            if (transition === "replace") successor = await service.openSession({
              ...opening("reader"), sessionId: reader.sessionId });
            checkpoint = await store.snapshot(workspaceId);
            eventsBefore = await store.eventsSince(workspaceId, null, 100);
          }
          return store.transaction(callback, options);
        } };
        const racing = createCoordinationService({ store: racingStore, clock, ids });

        await assert.rejects(racing[operation]({ ...owner(reader),
          messageId: message.messageId }), error => error.code === 5);
        assert.equal(armed, false, "the lifecycle transition was never exercised");
        assert.deepEqual(await store.snapshot(workspaceId), checkpoint);
        assert.deepEqual(await store.eventsSince(workspaceId, null, 100), eventsBefore);
        assert.equal(checkpoint.receipts[0].state, "queued");

        successor ??= await service.openSession({ ...opening("reader"),
          sessionId: reader.sessionId });
        assert.notEqual(successor.generation, reader.generation);
        const [recovered] = await service.readInbox(owner(successor));
        assert.equal(recovered.message.messageId, message.messageId);
        const answer = await service.replyToMessage({ ...owner(successor),
          messageId: message.messageId, clientMessageId: "client_answer", body: "Reviewed" });
        assert.equal(answer.receipt.state, "acknowledged");
        assert.equal(answer.reply.fromSessionId, successor.sessionId);
      });
    }
  }
});
