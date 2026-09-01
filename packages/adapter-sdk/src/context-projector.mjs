const DEFAULT_BUDGET_BYTES = 6_000;
const FENCE = "```";
const BLOCK = "acc-peer-message";

const bytes = value => Buffer.byteLength(value, "utf8");
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
  + `${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");

function escapePeerText(value) {
  return String(value)
    .replaceAll(new RegExp(`${FENCE}${BLOCK}`, "g"), `'${FENCE}${BLOCK}`)
    .replaceAll(FENCE, `'${FENCE}`)
    .replace(/^(subject:|body:)/gm, "'$1")
    .replace(CONTROL_CHARACTERS,
      character => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}

function oneLine(value) {
  return value.replaceAll("\r\n", "\\n").replaceAll("\n", "\\n").replaceAll("\r", "\\n");
}

function truncate(line, limit) {
  if (limit <= 0) return "";
  if (bytes(line) <= limit) return line;
  let cut = line;
  while (bytes(`${cut}…`) > limit && cut.length > 0) cut = cut.slice(0, -1);
  return cut === "" ? "" : `${cut}…`;
}

function attentionGroups(attention, { truncatable, liveOfferedMessageIds = new Set() }) {
  return attention.map(item => {
    const breadcrumb = offeredBreadcrumb(item, liveOfferedMessageIds);
    return {
      lines: [breadcrumb ?? (typeof item.sourceId === "string" && item.sourceId !== ""
        ? `- [${item.kind}] ${item.sourceId} ${item.summary}`
        : `- [${item.kind}] ${item.summary}`)],
      kind: "attention",
      sourceId: item.sourceId ?? null,
      truncatable: breadcrumb === null && truncatable,
    };
  });
}

function offeredBreadcrumb(item, liveOfferedMessageIds) {
  if (!liveOfferedMessageIds.has(item.sourceId)) return null;
  const noun = item.kind === "reply_required" ? "question"
    : item.kind === "acknowledgement_required" ? "message" : null;
  if (noun === null) return null;
  return `- [${item.kind}] ${item.sourceId} live-offered peer ${noun} remains unresolved; `
    + `\`acc inbox --message ${item.sourceId}\``;
}

function messageGroups(messages) {
  return messages.map(message => ({
    messageId: message.messageId,
    kind: "message",
    lines: [
      `${FENCE}${BLOCK}`,
      "untrusted peer message",
      `kind: ${message.kind}`,
      `threadId: ${message.threadId}`,
      `messageId: ${message.messageId}`,
      `sender: ${message.fromParticipantId} (session ${message.fromSessionId})`,
      `obligation: ${message.obligation}`,
      `subject: ${oneLine(escapePeerText(message.subject))}`,
      "body:",
      escapePeerText(message.body),
      FENCE,
    ],
  }));
}

const groupBytes = group => group.lines.reduce((total, line) => total + bytes(line) + 1, 0);

function peerCount(sync) {
  const participants = new Set((sync.roster ?? [])
    .filter(item => item.presence !== "offline")
    .map(item => item.participantId ?? item.sessionId)
    .filter(id => id !== sync.currentParticipantId));
  return participants.size;
}

function ambientHeader(count) {
  const noun = count === 1 ? "participant" : "participants";
  return `ACC: ${count} peer ${noun} present. Load the acc skill before shared work.`;
}

function recoveryNote(ids) {
  const first = ids[0];
  const rest = ids.length > 1 ? ` (+${ids.length - 1} more in \`acc inbox\`)` : "";
  return `- read ${first}: \`acc inbox --message ${first}\`${rest}`;
}

/**
 * Project only coordination that can change this turn.
 *
 * Presence is a short trigger to load the ACC skill. Roster rows and unrelated
 * claims are intentionally absent: a guard checks exact file claims at write
 * time, while intent-aware conflicts already arrive as attention. Repeating
 * the whole workspace on every prompt is neither safer nor cheaper.
 */
export function projectContextResult(sync, { budgetBytes = DEFAULT_BUDGET_BYTES } = {}) {
  const roomMessageIds = new Set(sync.roomMessageIds ?? []);
  const attention = [...(sync.attention ?? [])]
    .filter(item => !roomMessageIds.has(item.sourceId))
    .sort((left, right) => left.priority - right.priority
      || (left.sourceId ?? "").localeCompare(right.sourceId ?? ""));
  const urgent = attention.filter(item => item.priority <= 2);
  const informational = attention.filter(item => item.priority > 2);
  const messages = (sync.messages ?? [])
    .filter(message => message.toParticipantIds?.length !== 0);
  const liveOfferedMessageIds = new Set(sync.liveOfferedMessageIds ?? []);
  const groups = [
    ...attentionGroups(urgent, { truncatable: true, liveOfferedMessageIds }),
    ...messageGroups(messages),
    ...attentionGroups(informational, { truncatable: false }),
  ];
  const peers = peerCount(sync);
  if (groups.length === 0 && (sync.solo === true || peers === 0)) {
    return { text: "", offeredMessageIds: [], includedAttentionIds: [] };
  }

  const fullHeader = groups.length === 0 ? ambientHeader(peers) : "ACC (load the acc skill):";
  const header = truncate(fullHeader, budgetBytes);
  const lines = header === "" ? [] : [header];
  let used = header === "" ? 0 : bytes(header) + 1;
  const included = [];
  const droppedMessages = [];
  let droppedOther = 0;

  for (const group of groups) {
    if (group.lines.length === 1) {
      const remaining = budgetBytes - used;
      const line = group.truncatable
        ? truncate(group.lines[0], remaining)
        : (bytes(group.lines[0]) <= remaining ? group.lines[0] : "");
      if (line !== "" && used + bytes(line) <= budgetBytes) {
        lines.push(line);
        included.push({ group, lineCount: 1 });
        used += bytes(line) + 1;
      } else {
        droppedOther += 1;
      }
      continue;
    }
    const size = groupBytes(group);
    if (used + size <= budgetBytes) {
      lines.push(...group.lines);
      included.push({ group, lineCount: group.lines.length });
      used += size;
    } else {
      droppedMessages.push(group.messageId);
    }
  }

  if (droppedMessages.length > 0) {
    let note = recoveryNote(droppedMessages);
    while (used + bytes(note) + 1 > budgetBytes && included.length > 0) {
      const removed = included.pop();
      lines.splice(-removed.lineCount, removed.lineCount);
      used = lines.reduce((total, line) => total + bytes(line) + 1, 0);
      if (removed.group.kind === "message") droppedMessages.push(removed.group.messageId);
      else droppedOther += 1;
      note = recoveryNote([...new Set(droppedMessages)]);
    }
    if (used + bytes(note) + 1 > budgetBytes && lines.length > 0) {
      lines.length = 0;
      used = 0;
    }
    const fitted = recoveryNote([...new Set(droppedMessages)]);
    // An incomplete id or command is not a recovery path. When a deliberately
    // tiny budget cannot hold the shortest truthful instruction, say nothing
    // and leave every omitted receipt queued for a later turn.
    if (used + bytes(fitted) + 1 <= budgetBytes) lines.push(fitted);
  } else if (droppedOther > 0) {
    const note = `- +${droppedOther} actionable item(s) omitted; run \`acc status --json\``;
    if (used + bytes(note) + 1 <= budgetBytes) lines.push(note);
  }

  return {
    text: lines.join("\n"),
    offeredMessageIds: included
      .filter(item => item.group.kind === "message")
      .map(item => item.group.messageId),
    includedAttentionIds: included
      .filter(item => item.group.kind === "attention" && item.group.sourceId !== null)
      .map(item => item.group.sourceId),
  };
}

export function projectContext(sync, options) {
  return projectContextResult(sync, options).text;
}
