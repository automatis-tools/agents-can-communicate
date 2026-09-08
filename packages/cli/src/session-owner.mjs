import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Inbox retrieves bodies and advances receipts, so it needs the same owner
// proof as a mutation. Public observations never need somebody else's token.
const NEEDS_OWNER = Object.freeze(new Set(["work", "claim", "release", "message",
  "inbox", "reply", "request", "ack", "finish"]));
const WANTS_OWNER = Object.freeze(new Set(["sync", "status"]));

export const needsOwner = command => NEEDS_OWNER.has(command);

const unresolved = command => new AccError(EXIT.USAGE,
  `${command} could not tell which session is running it. Pass both --session and `
  + "--generation from this turn's ACC hook header or your own acc attach, or use this "
  + "session's ACC MCP tools. Do not copy a peer's session from acc status. Native "
  + "session IDs and a shared checkout do not establish CLI ownership.",
  { command, reasonCode: "caller_identity_unresolved" });

/**
 * Accept caller-supplied credentials; never discover credentials from peers.
 *
 * A sole binding, a matching checkout, and a public session selector all let an
 * unbound client adopt another session. Native environment values do too:
 * nested clients inherit their parent's IDs. Bindings identify hook payloads,
 * not arbitrary shell callers. ACC_SESSION/ACC_GENERATION remain an explicit
 * operator-supplied pair, not an assertion that environment provenance is known.
 */
export async function resolveOwner({ command, options, context, env = {} }) {
  const soft = WANTS_OWNER.has(command);
  if (!soft && !needsOwner(command)) return options;
  const explicit = options.session !== undefined && options.generation !== undefined;
  const configured = typeof env.ACC_SESSION === "string" && typeof env.ACC_GENERATION === "string";
  if (!explicit && !configured) {
    if (soft) return options;
    throw unresolved(command);
  }

  const owner = explicit ? options : { session: env.ACC_SESSION, generation: env.ACC_GENERATION };
  if (options.session !== undefined && options.session !== owner.session) {
    // A public observation scope is allowed; it does not request credentials.
    if (soft) return options;
    throw unresolved(command);
  }
  // A supplied generation must reach the core unchanged so stale calls fail.
  const resolved = { ...options, session: owner.session,
    generation: options.generation ?? owner.generation };
  if (command === "status" && options.participant === undefined) {
    const { participants } = await context.service.collectStatus({});
    resolved.participant = participants.find(item => item.sessionId === owner.session)?.participantId;
  }
  return resolved;
}
