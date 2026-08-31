// A note is fire-and-forget: shown to the recipient once, no acknowledgement
// owed, no standing reminder. Agents put decisions and warnings in notes anyway
// - in one measured session a note carrying a merge decision was lost for three
// hours - so this is the send-time tell that a note is waiting on a reply and
// should have gone out as a question (`--requires-ack`) or a decision.
//
// A nudge, never a block, and deliberately not a keyword list: keyword lists
// only fire in the language they were written in, and the agents here write in
// several. A question mark marks a question in every script, and the warning
// sign is the one glyph a peer reaches for when something must not be missed.
const QUESTION = /[?？]/u;
const WARNING = /⚠/u;

/**
 * Does this note read like it needs a response from the recipient?
 *
 * Pure and total: a missing subject or body is empty text, not an error, so the
 * caller can hand it a message record without pre-checking its shape.
 */
export function looksConsequential({ subject = "", body = "" } = {}) {
  const text = `${subject}\n${body}`;
  return QUESTION.test(text) || WARNING.test(text);
}
