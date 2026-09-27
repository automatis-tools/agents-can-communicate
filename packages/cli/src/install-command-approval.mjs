/**
 * The question after the delivery question: may ACC commands run in a client
 * without its approval prompt.
 *
 * Antigravity CLI asks before every shell command, so a session that a live
 * push woke stops at the agent's first ACC command until somebody answers
 * (issue #214). One allow rule in the client's own settings removes that. It
 * lets the agent run every ACC command unasked, which is a grant of its own,
 * so it is its own default-No question rather than a line inside the delivery
 * one - and it is asked only where it would change something: live delivery
 * on, and the adapter reporting that the rule is absent and can be added.
 *
 * The answer is recorded as `allowCommands` in the delivery decision, so it is
 * asked once. An explicit `--delivery` answers it the way it answers the rest
 * of complete setup: `actionable` or `all` is yes, `off` is no. A preview and a
 * run with nobody at the terminal record nothing and add no rule.
 */
const isInteractive = runtime => typeof runtime.isInteractive === "function"
  && runtime.isInteractive() === true;

const asksBeforeCommands = entry => entry.commandApproval !== null
  && typeof entry.commandApproval === "object";

function questionFor(entries) {
  const names = entries.map(entry => entry.displayName ?? entry.adapterId).join(", ");
  return [
    `Let ACC commands run without an approval prompt in ${names}?`,
    "  Yes: a session that ACC wakes can answer a peer while nobody is at the terminal.",
    "       The agent then runs every ACC command without asking you, including one a",
    "       peer's message prompts.",
    ...entries.map(entry => `       ${entry.displayName ?? entry.adapterId}: `
      + `${entry.commandApproval.setup}.`),
    "  No: each ACC command waits for your approval, so a live wake stops at the agent's",
    "      first ACC command until someone answers.",
  ].join("\n");
}

export async function decideCommandApproval({ explicit, detected, deliveryByAdapter,
  deliveryDecisionByAdapter, runtime, dryRun }) {
  const candidates = [];
  let withheld = 0;
  for (const entry of detected.filter(asksBeforeCommands)) {
    const id = entry.adapterId;
    const decision = deliveryDecisionByAdapter[id]
      ?? { source: "legacy-unknown", completeSetup: false };
    if (explicit !== undefined) {
      deliveryDecisionByAdapter[id] = { ...decision, allowCommands: explicit !== "off" };
      continue;
    }
    if ((deliveryByAdapter[id] ?? "off") === "off") continue;
    if (typeof decision.allowCommands === "boolean") continue;
    if (entry.commandApproval.state !== "prompts") continue;
    if (dryRun || !isInteractive(runtime)) {
      if (dryRun) withheld += 1;
      continue;
    }
    candidates.push(entry);
  }

  if (candidates.length > 0) {
    const yes = await runtime.confirm(questionFor(candidates),
      { input: runtime.input, output: runtime.output }) === true;
    for (const entry of candidates) {
      deliveryDecisionByAdapter[entry.adapterId] = {
        ...(deliveryDecisionByAdapter[entry.adapterId]
          ?? { source: "legacy-unknown", completeSetup: false }),
        allowCommands: yes };
    }
  }
  return { asked: candidates.map(entry => entry.adapterId),
    notes: withheld > 0
      ? ["interactive choices were not made: this preview keeps the approval prompt before "
        + `each ACC command for ${withheld} client(s) with live delivery on`]
      : [] };
}
