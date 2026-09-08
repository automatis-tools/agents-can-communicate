import { AccError, EXIT, MESSAGE_KINDS, assertPortableId }
  from "@agents-can-communicate/protocol";

const DEFAULT_LIMIT = 20;
const PAGE_BYTES = 12_000;
const usage = message => { throw new AccError(EXIT.USAGE, message); };
const newestFirst = (a, b) => b.sentAt.localeCompare(a.sentAt)
  || b.messageId.localeCompare(a.messageId);

export function assertMessageId(value, label = "message id") {
  try { assertPortableId(value, label); }
  catch { usage(`${label} must be a complete message id returned by ACC`); }
}

function shortSubject(subject) {
  if (Buffer.byteLength(subject) <= 160) return subject;
  let text = "";
  for (const character of subject) {
    if (Buffer.byteLength(text + character + "…") > 160) break;
    text += character;
  }
  return `${text}…`;
}

export function messageSummary(message) {
  // An allowlist keeps artifacts, handoff details, and future peer payload
  // fields out of discovery. A summary is not a retrieved message body.
  return {
    messageId: message.messageId, threadId: message.threadId,
    fromParticipantId: message.fromParticipantId, fromSessionId: message.fromSessionId,
    kind: message.kind, obligation: message.obligation,
    subject: shortSubject(message.subject), sentAt: message.sentAt,
    inReplyTo: message.inReplyTo, bodyBytes: Buffer.byteLength(message.body),
    artifactCount: message.artifacts.length, trust: "untrusted peer content",
    ...(message.decisionStatus === undefined ? {} : { decisionStatus: message.decisionStatus }),
  };
}

export function messagePage(messages, input, { include = () => true,
  project = messageSummary, metadata = {} } = {}) {
  const limit = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    usage("message list limit must be an integer from 1 to 500");
  }
  if (input.kind !== undefined && !MESSAGE_KINDS.includes(input.kind)) {
    usage(`message type is one of ${MESSAGE_KINDS.join(", ")}`);
  }
  let anchor = null;
  if (input.cursor != null) {
    assertMessageId(input.cursor, "message cursor");
    anchor = messages.find(message => message.messageId === input.cursor);
    if (anchor === undefined || (input.kind !== undefined && anchor.kind !== input.kind)) {
      usage("message cursor is not in this message list; start again without a cursor");
    }
  }
  // Resolve the anchor before filtering pending state. Reading or resolving
  // that message between pages must not shift the next page as an offset would.
  const selected = messages.filter(message => include(message)
    && (input.kind === undefined || message.kind === input.kind)
    && (anchor === null || newestFirst(message, anchor) > 0)).sort(newestFirst);
  const items = [];
  for (const message of selected.slice(0, limit)) {
    const item = project(message);
    // Reserve a complete continuation id even when count, rather than bytes,
    // eventually ends the page. Never slice a summary or a recovery id in half.
    const candidate = { ...metadata, items: [...items, item], nextCursor: message.messageId };
    if (Buffer.byteLength(JSON.stringify(candidate, null, 2)) > PAGE_BYTES) break;
    items.push(item);
  }
  if (selected.length > 0 && items.length === 0) {
    throw new AccError(EXIT.DATA, "one message summary exceeds the page budget");
  }
  return { ...metadata, items, nextCursor: items.length < selected.length
    ? selected[items.length - 1].messageId : null };
}
