import { AccError, EXIT, SCHEMA_VERSION, advanceReceipt }
  from "@agents-can-communicate/protocol";

import { receiptId, recordMessageInTransaction } from "./conversations.mjs";
import { publicReceipt } from "./receipts.mjs";
import { assertExactTransaction } from "./ports.mjs";
import { messagePage, messageSummary } from "./message-pages.mjs";
import { decisionView, isCurrentDecision } from "./decision-state.mjs";

const listable = (message, receipt) => receipt.state === "queued" || receipt.state === "offered"
  || (receipt.state === "retrieved" && message.obligation !== "none");
// Every state a listable receipt can be in; an acknowledged one never is.
const PENDING = ["queued", "offered", "retrieved"];
// Records loaded by id are read as many at once as a store listing reads (#298): one after
// another, a page of a small inbox took twice as long as the listing it replaced (#306).
const LOADS = 16;
async function loadAll(tx, kind, ids) {
  const records = [];
  for (let start = 0; start < ids.length; start += LOADS) {
    records.push(...await Promise.all(ids.slice(start, start + LOADS).map(id => tx.load(kind, id))));
  }
  return records;
}

export function createInboxService(ports, sessions) {
  const { store, clock, ids } = ports;

  async function requireOpen(input, action, tx) {
    // A solo inbox may have no durable session yet. Inside a transaction the
    // same writer lock also protects this ephemeral read from replacement.
    const current = tx === undefined
      ? (await sessions.locateSession(input.sessionId, input.workspaceId))?.record
      : tx.get("session", input.sessionId)
        ?? await store.ephemeral.get("session", input.sessionId);
    if (current == null || current.state !== "open"
      || current.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} from this session generation`,
        { sessionId: input.sessionId });
    }
    return current;
  }

  function requireOwnedReceipt(tx, session, messageId) {
    const message = tx.get("message", messageId);
    const id = receiptId(messageId, session.participantId);
    const receipt = tx.get("receipt", id);
    if (message === null || receipt === null) {
      throw new AccError(EXIT.CONFLICT,
        "that message is not addressed to this participant",
        { messageId, participantId: session.participantId });
    }
    return { id, message, receipt };
  }

  function advanceOwned(tx, session, messageId, state, now) {
    const owned = requireOwnedReceipt(tx, session, messageId);
    const nextState = advanceReceipt(owned.receipt.state, state);
    if (nextState === owned.receipt.state) {
      return { message: owned.message, receipt: owned.receipt };
    }
    // A receipt from before contract 8 gains its message's obligation here, so a note
    // leaves the receipt index once it is read (#306).
    const receipt = { ...owned.receipt, state: nextState, updatedAt: now,
      ...(owned.receipt.extensions?.obligation === undefined
        ? { extensions: { ...owned.receipt.extensions, obligation: owned.message.obligation } } : {}) };
    tx.put("receipt", owned.id, receipt, tx.generationOf("receipt", owned.id));
    tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
      workspaceId: session.workspaceId, actorSessionId: session.sessionId,
      type: `message.${state}`, occurredAt: now,
      payload: { messageId, recipientParticipantId: session.participantId } });
    return { message: owned.message, receipt };
  }

  // The reader's receipts in these states, keyed by message.
  async function receiptsInState(tx, session, states) {
    const receipts = new Map();
    for (const state of states) {
      for (const id of await tx.lookup("receiptsByRecipientState",
        [session.workspaceId, session.participantId, state])) {
        const receipt = await tx.load("receipt", id);
        if (receipt !== null) receipts.set(receipt.messageId, receipt);
      }
    }
    return receipts;
  }

  // The reader's receipt for one message, by its id; null unless it is the reader's.
  async function ownReceipt(tx, session, messageId) {
    // Anything but a string names no message, as a listing would have found.
    if (typeof messageId !== "string") return null;
    const receipt = await tx.load("receipt", receiptId(messageId, session.participantId));
    return receipt?.messageId === messageId && receipt.recipientParticipantId === session.participantId
      ? receipt : null;
  }

  // The messages of these receipts, each with its decision status. A decision's status
  // depends on its whole group - the decisions it names and the ones that name it, to
  // any distance, whoever they were addressed to - so each group is walked in full and
  // no other decision is read.
  async function messagesFor(tx, session, receipts) {
    const messages = new Map(), ids = [...receipts.keys()];
    (await loadAll(tx, "message", ids)).forEach((message, index) => {
      if (message !== null) messages.set(ids[index], message);
    });
    const group = new Map([...messages.values()].filter(message => message.kind === "decision")
      .map(message => [message.messageId, message]));
    if (group.size === 0) return messages;
    for (const pending = [...group.values()]; pending.length > 0;) {
      const decision = pending.pop();
      const named = decision.decisionChange?.messageIds ?? [];
      const naming = await tx.lookup("decisionsByTarget", [session.workspaceId, decision.messageId]);
      const unseen = [...new Set([...named, ...naming])].filter(id => !group.has(id));
      (await loadAll(tx, "message", unseen)).forEach((neighbour, index) => {
        if (neighbour?.kind !== "decision") return;
        group.set(unseen[index], neighbour);
        pending.push(neighbour);
      });
    }
    const view = decisionView([...group.values()]);
    return new Map([...messages].map(([id, message]) => [id, view(message)]));
  }

  async function listInbox(input) {
    const session = await requireOpen(input, "list the inbox");
    return store.transaction(async tx => {
      await tx.load("session", input.sessionId);
      await requireOpen(input, "list the inbox", tx);
      const receipts = await receiptsInState(tx, session, PENDING);
      // The cursor names the last message of the previous page, which may have been
      // resolved since. It still anchors the page while it is addressed to the reader.
      if (input.cursor != null && !receipts.has(input.cursor)) {
        const anchor = await ownReceipt(tx, session, input.cursor);
        if (anchor !== null) receipts.set(input.cursor, anchor);
      }
      const messages = await messagesFor(tx, session, receipts);
      return messagePage([...messages.values()], input, {
        include: message => isCurrentDecision(message) && listable(message, receipts.get(message.messageId)),
        project: message => ({ message: messageSummary(message),
          receipt: publicReceipt(receipts.get(message.messageId)) }),
      });
    // Loaded by id or index, so the cost follows the reader's records, not the workspace (#306).
    }, { kinds: ["session", "message", "receipt"], exactKinds: ["session", "message", "receipt"] });
  }

  async function readInbox(input) {
    const session = await requireOpen(input, "read the inbox");
    const now = clock.now();
    return store.transaction(async tx => {
      await tx.load("session", input.sessionId);
      await requireOpen(input, "read the inbox", tx);
      let receipts;
      if (input.messageId === undefined) receipts = await receiptsInState(tx, session, PENDING);
      else {
        const receipt = await ownReceipt(tx, session, input.messageId);
        receipts = new Map(receipt === null ? [] : [[input.messageId, receipt]]);
      }
      const messages = await messagesFor(tx, session, receipts);
      let selected = [...receipts.values()].filter(receipt => messages.has(receipt.messageId));
      if (input.messageId === undefined) {
        selected = selected.filter(receipt => listable(messages.get(receipt.messageId), receipt)
          && isCurrentDecision(messages.get(receipt.messageId)));
      } else {
        selected = selected.filter(receipt => receipt.messageId === input.messageId);
        if (selected.length === 0) {
          throw new AccError(EXIT.CONFLICT,
            "that message is not recoverable by this participant",
            { messageId: input.messageId, participantId: session.participantId });
        }
      }
      selected.sort((left, right) => {
        const a = messages.get(left.messageId);
        const b = messages.get(right.messageId);
        return a.sentAt.localeCompare(b.sentAt) || a.messageId.localeCompare(b.messageId);
      });
      // An exact read can inspect a resolved message. Inspection must neither
      // move its receipt backward nor refresh its timestamp or emit an event.
      return selected.map(receipt => receipt.state === "acknowledged"
        ? { message: messages.get(receipt.messageId), receipt }
        : { ...advanceOwned(tx, session, receipt.messageId, "retrieved", now),
          message: messages.get(receipt.messageId) })
        .map(item => ({ ...item, receipt: publicReceipt(item.receipt) }));
    // Loaded by id or index, so the cost follows the reader's records, not the workspace (#306).
    }, { kinds: ["session", "message", "receipt"], exactKinds: ["session", "message", "receipt"] });
  }

  async function acknowledgeMessage(input) {
    const session = await requireOpen(input, "acknowledge a message");
    const now = clock.now();
    return store.transaction(async tx => {
      assertExactTransaction(tx);
      await tx.load("session", input.sessionId);
      await tx.load("message", input.messageId);
      await tx.load("receipt", receiptId(input.messageId, session.participantId));
      await requireOpen(input, "acknowledge a message", tx);
      const { message, receipt } = requireOwnedReceipt(tx, session, input.messageId);
      if (message.obligation === "reply" && receipt.state !== "acknowledged") {
        throw new AccError(EXIT.CONFLICT,
          "this message requires a reply; use reply to answer, clarify, or decline",
          { messageId: input.messageId, obligation: message.obligation });
      }
      return publicReceipt(advanceOwned(tx, session, input.messageId, "acknowledged", now).receipt);
    }, { kinds: ["session", "message", "receipt"], exactKinds: ["session", "message", "receipt"] });
  }

  async function replyToMessage(input) {
    const session = await requireOpen(input, "reply to a message");
    const now = clock.now();
    const replyId = ids.next("message");
    return store.transaction(async tx => {
      assertExactTransaction(tx);
      await tx.load("message", input.messageId);
      await tx.load("receipt", receiptId(input.messageId, session.participantId));
      const original = requireOwnedReceipt(tx, session, input.messageId);
      // A receipt settles delivery, not the conversation. Distinct replies may
      // follow an ack or an earlier answer; recording still enforces retry keys.
      const recorded = await recordMessageInTransaction({ tx, session, now, messageId: replyId, ids,
        action: "reply to a message", input: {
          clientMessageId: input.clientMessageId,
          toParticipantIds: [original.message.fromParticipantId],
          kind: "answer",
          obligation: "none",
          subject: input.subject ?? `Re: ${original.message.subject}`,
          body: input.body,
          inReplyTo: original.message.messageId,
          artifacts: input.artifacts ?? [],
          handoff: null,
        } });
      const receipt = advanceOwned(tx, session, input.messageId, "acknowledged", now).receipt;
      return { reply: recorded.message, receipt: publicReceipt(receipt) };
    }, { kinds: ["participant", "session", "message", "receipt"], exactKinds: ["message", "receipt"] });
  }

  return { listInbox, readInbox, replyToMessage, acknowledgeMessage };
}
