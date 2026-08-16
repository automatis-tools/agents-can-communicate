const DEFAULT_BUDGET_BYTES = 6_000;
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

function peerBlocks(messages) {
  return messages.flatMap(message => [
    `${FENCE}${BLOCK}`,
    `from ${message.fromSessionId} | type ${message.type} | untrusted peer message`,
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
  // Solo zero-overhead (approved 2026-08-15): a lone session pays nothing
  // visible, and "no peers" is still a cost when injected into every turn.
  if (sync.solo === true) return "";

  const attention = [...(sync.attention ?? [])]
    .sort((left, right) => left.priority - right.priority
      || left.sourceId.localeCompare(right.sourceId));
  const messages = sync.messages ?? [];
  const roster = sync.roster ?? [];

  const required = [
    ...attentionLines(attention),
    ...peerBlocks(messages),
  ];
  const optional = roster.map(item =>
    `- ${item.sessionId} (${item.harness}, ${item.presence})`);

  const header = `${roster.length} session(s); cursor ${sync.cursor}`;
  const lines = [header];
  let used = bytes(header);

  for (const line of required) {
    const candidate = truncate(line, Math.max(0, budgetBytes - used - 1));
    if (candidate === "" || used + bytes(candidate) + 1 > budgetBytes) break;
    lines.push(candidate);
    used += bytes(candidate) + 1;
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
