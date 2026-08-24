import { AccError, EXIT } from "@agents-can-communicate/protocol";

/**
 * Everyone this workspace has ever seen.
 *
 * Participants are created when a session attaches and are never removed, so
 * "has been here" is the right test and "is here now" is not: work is addressed
 * to a participant precisely so it survives their session ending.
 *
 * Before anything durable is written the participants live in the ephemeral
 * area, which is where a workspace with one session keeps everything.
 */
export async function knownParticipants(store, workspaceId) {
  const snapshot = await store.snapshot(workspaceId,
    { kinds: ["workspace", "participant"] });
  const durable = snapshot.workspace !== null
    ? snapshot.participants
    : await store.ephemeral.list("participant");
  return new Set(durable.map(participant => participant.participantId));
}

/**
 * A recipient nobody has ever been is a typo, and saying "sent" to one is the
 * worst answer available: `acc message --to physcis` reported success, the
 * message went nowhere, and the agent that meant `physics` had no way to find
 * out. `acc request` was worse - it made a task addressed to nobody, and the
 * requester waited for an agent that does not exist.
 *
 * It also bounds the recipient list by construction. Nothing did: one message
 * naming three thousand participants took 24.8 seconds, wrote three thousand
 * receipts, and left every session in that workspace paying 5.1 seconds to
 * attach and take one turn - past the point where a hook gives up and allows
 * whatever it was guarding.
 */
export async function assertKnownParticipants(store, workspaceId, recipients) {
  const known = await knownParticipants(store, workspaceId);
  const strangers = [...new Set(recipients)].filter(name => !known.has(name));
  if (strangers.length === 0) return;
  // Not a usage error: the command is well formed and the workspace disagrees
  // with it. Which matters beyond tidiness - the gate that runs every documented
  // command holds them to being *accepted*, and every example names a peer that
  // a fresh sandbox has never seen.
  throw new AccError(EXIT.DATA,
    `no participant here is called ${strangers.join(", ")}. `
    + `This workspace has: ${[...known].sort().join(", ") || "nobody else yet"}`,
    { strangers, known: [...known].sort() });
}

