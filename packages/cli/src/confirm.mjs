import { once } from "node:events";
import { createInterface } from "node:readline/promises";

/**
 * Ask a yes-or-no question and wait for the answer.
 *
 * A port rather than a call to the terminal, so the composition root hands it
 * in and a test hands in two streams instead. There was no port at all:
 * `runtime.confirm` fell back to a function that always answered no, so `acc
 * config init` in a real terminal printed `not written` and never said why -
 * and `--yes`, documented for runs with nobody to ask, was the only way to
 * write the file.
 *
 * Anything that is not yes is no. A confirmation that reads a stray newline as
 * agreement is not a confirmation.
 */
export async function askConfirmation(question, { input, output }) {
  const dialogue = createInterface({ input, output });
  try {
    const asked = dialogue.question(`${question}\n[y/N] `);
    // The input closing before an answer arrives is the reader leaving - Ctrl+D,
    // or a pipe that ended - which is a refusal rather than a failure. Raced
    // rather than caught: the question simply never settles on a stream that
    // ends, so waiting for it alone hangs.
    asked.catch(() => {});
    const answer = await Promise.race([asked, once(dialogue, "close").then(() => "")]);
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    dialogue.close();
  }
}
