// Peer text a model reads, kept where ACC put it (#143). A Markdown code block
// ends only at a line that starts with three or more backticks, and every ``` in
// peer text gets a leading quote, so no line of a peer body can close the block
// ACC opened for it. What follows ACC's own closing fence is ACC's again: a body
// that imitates a second frame, a sender or a message id stays inside the block.
const FENCE = "```";
const BLOCK = "acc-peer-message";

const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
  + `${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, "g");

/** Peer text with every fence quoted, frame labels quoted and controls shown as escapes. */
export function escapePeerText(value) {
  return String(value)
    .replaceAll(new RegExp(`${FENCE}${BLOCK}`, "g"), `'${FENCE}${BLOCK}`)
    .replaceAll(FENCE, `'${FENCE}`)
    // A multiline `^` stops after LF, CR, U+2028 and U+2029, but not after NEL.
    .replace(/(^|\u0085)(subject:|body:)/gm, "$1'$2")
    .replace(CONTROL_CHARACTERS,
      character => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}

/** The opening and closing lines of the block a live push puts a peer body in. */
export const PEER_BODY_FENCE = Object.freeze([`${FENCE}acc-peer-body`, FENCE]);

export { BLOCK as PEER_MESSAGE_BLOCK, FENCE as PEER_FENCE };
