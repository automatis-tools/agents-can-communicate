const DEFAULT_BUDGET_BYTES = 6_000;
// Held back from the required lines so the "not shown" note can always be
// written. A projection that silently drops what it could not fit is how an
// agent ends up confidently unaware.
const NOTE_RESERVE = 48;
const FENCE = "```";
// A peer cannot close a block it cannot name. The fence carries a marker that
// is stripped from peer content, so forged delimiters stay inside the block.
const BLOCK = "acc-peer-message";

const bytes = value => Buffer.byteLength(value, "utf8");

// Written from char codes rather than a literal class: an escaped control
// range in a regex literal is corrupted silently by editors and patches, and a
// corrupted range fails open.
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
  + `${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");

/**
 * Render peer-controlled text as displayable data.
 *
 * Two separate jobs. Control sequences become visible escapes, so a message
 * cannot repaint or retitle the human's terminal. Fence markers are stripped,
 * so a message cannot break out of its own data block and continue as if ACC
 * had written the following lines.
 */
function escapePeerText(value) {
  return String(value)
    .replaceAll(new RegExp(`${FENCE}${BLOCK}`, "g"), `'${FENCE}${BLOCK}`)
    .replaceAll(FENCE, `'${FENCE}`)
    .replace(CONTROL_CHARACTERS,
      character => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}

function truncate(line, limit) {
  if (bytes(line) <= limit) return line;
  let cut = line;
  while (bytes(`${cut}…`) > limit && cut.length > 0) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function attentionLines(attention) {
  return attention.map(item => `- [${item.kind}] ${item.summary}`);
}

/**
 * Claims other sessions hold, and whether this session can be stopped from
 * breaking them.
 *
 * Ranked with the required lines rather than the roster, because a claim is
 * what changes what this session should do next. When it cannot be enforced -
 * a model that edits through the shell, an MCP client with no hooks - saying so
 * is the whole mitigation: ACC will not intercept the write, so respecting the
 * claim is this session's own responsibility and it needs to know that.
 */
function claimNote(claim) {
  // Enforcement is declared per claim, and the guard only ever blocks a guarded
  // one. Reading this session's capability alone would announce a block that
  // will never happen, on a claim whose owner explicitly did not ask for one.
  if (claim.enforcement !== "guarded") {
    return " - advisory; nothing will stop you, the owner is asking";
  }
  if (claim.enforceable === false) {
    return " - not enforced for this session; do not edit it";
  }
  // Guarded, and this session can be stopped - but only on a file edit. No
  // harness intercepts a shell command, so an edit made through one goes
  // through whatever the claim says, and a session told merely "this is
  // claimed" would reasonably assume otherwise.
  return " - file edits are blocked; edits made through a shell are not";
}

function claimLines(claims) {
  return claims.map(claim => {
    const owner = claim.ownerParticipantId ?? claim.ownerSessionId ?? "another session";
    return `- [claim] ${claim.resource} held by ${owner}${claimNote(claim)}`;
  });
}

/**
 * One group per message, never a flat list of lines.
 *
 * A block that the budget cuts in half is worse than a block that was left out:
 * the fence never closes, and everything after it reads as ACC's own words
 * rather than as a peer's. So a message is included whole or not at all.
 *
 * The id is carried because the reader needs it to acknowledge the message, and
 * because the caller needs it to tell which messages actually reached the model
 * before recording any of them as delivered. Ids, session ids and types are
 * generated or schema-validated; only the subject and body are peer-authored,
 * and only those are escaped.
 */
function peerBlocks(messages) {
  return messages.map(message => [
    `${FENCE}${BLOCK}`,
    `id ${message.messageId} | from ${message.fromSessionId} | type ${message.type}`
    + " | untrusted peer message",
    escapePeerText(message.subject),
    escapePeerText(message.body),
    FENCE,
  ]);
}

/**
 * Project a SyncResult into bounded text for one adapter to inject.
 *
 * Priority is fixed: direct requests and conflicts first, roster detail last,
 * because the budget is spent from the bottom. Whatever is dropped is counted
 * rather than silently removed - a projection that hides its own omissions is
 * how an agent ends up confidently unaware.
 */
export function projectContext(sync, { budgetBytes = DEFAULT_BUDGET_BYTES } = {}) {
  const attention = [...(sync.attention ?? [])]
    .sort((left, right) => left.priority - right.priority
      || left.sourceId.localeCompare(right.sourceId));
  const messages = sync.messages ?? [];
  const roster = sync.roster ?? [];
  const claims = sync.claims ?? [];

  // Every entry is a group that appears whole or not at all. Single-line groups
  // may still be truncated - there is no fence in them to leave open.
  const required = [
    ...attentionLines(attention).map(line => [line]),
    ...claimLines(claims).map(line => [line]),
    ...peerBlocks(messages),
  ];
  // Solo costs nothing: a lone session pays no visible price, and "no peers" is
  // still a cost when injected into every turn. But this is decided after the
  // required lines are built, not before - a message already addressed to you,
  // or a claim you could break, is not nothing, and returning early swallowed
  // exactly the things worth saying to someone working alone.
  if (sync.solo === true && required.length === 0) return "";

  // Named by participant, because that is what another agent addresses work to
  // - a session id cannot be used with `--to`. The branch says where they are,
  // which is how a workspace spanning several worktrees stays legible.
  const optional = roster.map(item => {
    const who = item.participantId ?? item.sessionId;
    const place = item.branch === null || item.branch === undefined
      ? ""
      : ` on ${item.branch}`;
    return `- ${who}${place} (${item.harness}, ${item.presence})`;
  });

  const header = `${roster.length} session(s); cursor ${sync.cursor}`;
  const lines = [header];
  let used = bytes(header);

  // Reserved so the note below always fits. Without it the projection could run
  // out of room to say that it ran out of room.
  const ceiling = budgetBytes - NOTE_RESERVE;
  let dropped = 0;
  for (const group of required) {
    if (group.length === 1) {
      const candidate = truncate(group[0], Math.max(0, ceiling - used - 1));
      if (candidate === "" || used + bytes(candidate) + 1 > ceiling) { dropped += 1; continue; }
      lines.push(candidate);
      used += bytes(candidate) + 1;
      continue;
    }
    const size = group.reduce((total, line) => total + bytes(line) + 1, 0);
    // Skipped rather than stopped at: the groups are ordered by priority, and a
    // large message must not hide the shorter ones behind it.
    if (used + size > ceiling) { dropped += 1; continue; }
    lines.push(...group);
    used += size;
  }
  if (dropped > 0) {
    const note = `- +${dropped} not shown, over budget`;
    lines.push(note);
    used += bytes(note) + 1;
  }

  let shown = 0;
  for (const line of optional) {
    if (used + bytes(line) + 1 > budgetBytes - 16) break;
    lines.push(line);
    used += bytes(line) + 1;
    shown += 1;
  }
  if (shown < optional.length) {
    const note = `- +${optional.length - shown} more`;
    if (used + bytes(note) + 1 <= budgetBytes) lines.push(note);
  }

  return lines.join("\n");
}
