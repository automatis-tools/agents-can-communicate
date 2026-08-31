const DEFAULT_BUDGET_BYTES = 6_000;
// Held back from the required lines so the "not shown" note can always be
// written. A projection that silently drops what it could not fit is how an
// agent ends up confidently unaware.
// Enough for the note *and* the command that reads what the note is about. It
// said only that something had been withheld, and nothing anywhere - not the
// skills, not the docs - said how to see it. A turn that reports a thing the
// reader cannot reach is how an agent ends up inventing its own way in.
// Enough for the longest over-budget note - the escalated "message did not fit"
// line, which is longer than the plain "+N not shown" it replaces. Kept small
// enough that the note still fits beside a header at the smallest budgets.
const NOTE_RESERVE = 90;
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
    // The labels that frame this block are ACC's words at the start of a line.
    // A peer writing one would otherwise produce a second line reading as ACC
    // framing a different message - the same break-out the fence rule prevents,
    // and neutralised the same way rather than by reflowing the text, which a
    // handoff body cannot survive.
    .replace(/^(subject:|body:)/gm, "'$1")
    .replace(CONTROL_CHARACTERS,
      character => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}

function truncate(line, limit) {
  if (bytes(line) <= limit) return line;
  let cut = line;
  while (bytes(`${cut}…`) > limit && cut.length > 0) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * An attention line an agent can act on without a round trip.
 *
 * `- [task_unblocked] Tank sinks through mud` says work is waiting and does not
 * say which work. The commands that take it - `acc task --take --task <id>` -
 * all need the id, and the only other place it appears is `acc sync --json`. An
 * agent that is told to act and not told on what improvises, which in this
 * project has already meant one hand-editing the store rather than admitting it
 * could not name the task.
 *
 * Every kind carries such an id and every one is the argument to a command:
 * a message to `acc ack --message`, a task to `acc task --task`, a claim to
 * `acc release --claim`. So they are all shown, not only the ones that happened
 * to be noticed first.
 */
function attentionLines(attention) {
  return attention.map(item => (typeof item.sourceId === "string" && item.sourceId !== ""
    ? `- [${item.kind}] ${item.sourceId} ${item.summary}`
    : `- [${item.kind}] ${item.summary}`));
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
  // Guarded, and this session can be stopped - on a file edit, and on the shell
  // writes the guard can read: a redirection, an operand of a command whose job
  // is to put bytes somewhere. A language runtime opening the file itself still
  // gets past, and a session told merely "this is claimed" would reasonably
  // assume either more or less than is true.
  return " - file edits and recognised shell writes are blocked; a runtime can still get past";
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
    `subject: ${oneLine(escapePeerText(message.subject))}`,
    "body:",
    escapePeerText(message.body),
    FENCE,
  ]);
}

/**
 * A subject is one line, whatever the peer sent.
 *
 * The subject sits on the label's own line, so a newline inside it would push
 * peer text to column 0 where ACC's labels live. Rendering the break visibly
 * keeps the text readable and the frame ACC's.
 */
function oneLine(value) {
  return value.replaceAll("\r\n", "\\n").replaceAll("\n", "\\n").replaceAll("\r", "\\n");
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
  // Who is here, which is not the same as who has ever been here. The roster
  // keeps closed sessions - `sync` needs them to decide what a cursor has missed
  // - and a turn that lists them says "3 session(s)" for two participants, one
  // of them shown twice with contradictory presence. Left alone it also grows
  // without limit: every session ever opened would take a line out of the
  // context budget, crowding out messages actually addressed to the reader.
  // Stale stays: a session that crashed holding a claim is very much news.
  const roster = (sync.roster ?? []).filter(item => item.presence !== "offline");
  const claims = sync.claims ?? [];

  // Every entry is a group that appears whole or not at all. Single-line groups
  // may still be truncated - there is no fence in them to leave open. `message`
  // is carried so a dropped message can be counted apart from a dropped
  // reminder: the two are not the same news.
  //
  // A peer message sits after "act now" attention (a direct request, an imminent
  // conflict: priority <= 2) and ahead of standing reminders. The order is the
  // fix for a real starvation: an expired-claim line (priority 6) regenerates
  // from state every turn, while a message is delivered once and its receipt
  // then stops it appearing - so a reminder that never clears must not keep
  // pushing a one-time message into the over-budget overflow, turn after turn,
  // where two agents each lost their most important message to it.
  const urgent = attention.filter(item => item.priority <= 2);
  const info = attention.filter(item => item.priority > 2);
  const required = [
    ...attentionLines(urgent).map(line => ({ lines: [line], message: false })),
    ...peerBlocks(messages).map(block => ({ lines: block, message: true })),
    ...attentionLines(info).map(line => ({ lines: [line], message: false })),
    ...claimLines(claims).map(line => ({ lines: [line], message: false })),
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
  let droppedOther = 0;
  let droppedMessages = 0;
  const drop = group => { if (group.message) droppedMessages += 1; else droppedOther += 1; };
  for (const group of required) {
    const block = group.lines;
    if (block.length === 1) {
      const candidate = truncate(block[0], Math.max(0, ceiling - used - 1));
      if (candidate === "" || used + bytes(candidate) + 1 > ceiling) { drop(group); continue; }
      lines.push(candidate);
      used += bytes(candidate) + 1;
      continue;
    }
    const size = block.reduce((total, line) => total + bytes(line) + 1, 0);
    // Skipped rather than stopped at: the groups are ordered by priority, and a
    // large message must not hide the shorter ones behind it.
    if (used + size > ceiling) { drop(group); continue; }
    lines.push(...block);
    used += size;
  }
  // A dropped message is louder than a dropped reminder: "+N not shown" read as
  // noise to two agents who each lost their most important message to it, so a
  // message that did not fit says so specifically and names the command that
  // recovers it. One note either way, escalated when a message is among the loss.
  // The note is guarded against the budget, not merely reserved for: at a
  // pathologically small budget the header alone can leave less room than the
  // note needs, and a projection that overran the very budget it exists to
  // respect is the bug this whole function is careful about. If the full note
  // will not fit, the shortest imperative that does is still not silence.
  const pushNote = note => {
    const short = "- ⚠ over budget; `acc sync --scope full --json`";
    for (const candidate of [note, short]) {
      if (used + bytes(candidate) + 1 <= budgetBytes) {
        lines.push(candidate);
        used += bytes(candidate) + 1;
        return;
      }
    }
  };
  if (droppedMessages > 0) {
    // No count of the other drops: `--scope full` recovers everything.
    pushNote(`- ⚠ ${droppedMessages} message(s) addressed to you did not fit; `
      + "run `acc sync --scope full --json`");
  } else if (droppedOther > 0) {
    pushNote(`- +${droppedOther} not shown, over budget; read them with `
      + "`acc sync --scope full --json`");
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
