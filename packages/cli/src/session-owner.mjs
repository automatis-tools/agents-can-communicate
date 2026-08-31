import { listSessionBindings } from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

/**
 * Work out which session is running this command.
 *
 * Every mutating command needs a session id and the generation that proves the
 * caller is that session. Until this existed, both had to be passed on the
 * command line, and the shipped skills told agents to pass
 * `--session "$ACC_SESSION" --generation "$ACC_GENERATION"` - two variables that
 * nothing in the system has ever set. The generation is not printed by `acc
 * status` either, deliberately: it is the proof of ownership, not public
 * information. So the documented workflow could not be carried out by any agent
 * on any client, and the only way through was to read ACC's own files by hand,
 * which the same skill forbids in as many words.
 *
 * The hook runtime already knows both. It writes them into a binding at
 * SessionStart, keyed by the harness's own session id. What was missing was a
 * way for a shell inside that session to find its own binding. Each step below
 * answers that from something the caller demonstrably has.
 */
const NEEDS_OWNER = Object.freeze(new Set(["work", "claim", "release", "message",
  "inbox", "reply", "request", "ack", "workstream", "task", "finish", "decide"]));

/**
 * Reads that are answers about *you*.
 *
 * Attention is computed per session: what is addressed to you, what has become
 * unblocked for you. Run by hand with nothing identifying the caller, both of
 * these answered for nobody and returned an empty list - so an agent told at the
 * top of its turn that work was waiting could ask `acc status` and be told there
 * was none. They resolve softly: a shell with no session attached still gets the
 * roster and the events, which is what it came for.
 */
const WANTS_OWNER = Object.freeze(new Set(["sync", "status"]));

export const needsOwner = command => NEEDS_OWNER.has(command);

/**
 * Bindings whose session is still open, carrying the session's own checkout.
 *
 * A binding outlives a crash, so one that names a closed or vanished session is
 * a leftover. Acting as a closed session would fail deeper in the service with a
 * conflict; dropping it here means the *next* candidate can be recognised
 * instead.
 */
async function liveCandidates({ context }) {
  const bindings = await listSessionBindings({ runtimeDir: context.paths.root });
  if (bindings.length === 0) return [];
  const status = await context.service.collectStatus({});
  const live = new Map(status.participants
    .filter(participant => participant.presence !== "offline")
    .map(participant => [participant.sessionId, participant]));
  return bindings
    .filter(binding => live.has(binding.accSessionId))
    .map(binding => ({ ...binding, session: live.get(binding.accSessionId) }));
}

const describe = candidates => candidates
  .map(candidate => `${candidate.session.participantId} (${candidate.session.harness})`)
  .join(", ");

export async function resolveOwner({ command, options, context, env = {} }) {
  const soft = WANTS_OWNER.has(command);
  if (!soft && !needsOwner(command)) return options;
  if (options.session !== undefined && options.generation !== undefined) return options;
  if (soft && options.participant !== undefined) return options;

  const candidates = await liveCandidates({ context });
  const take = candidate => ({ ...options, session: candidate.accSessionId,
    generation: candidate.generation,
    // `status` filters by participant rather than by session, so it is told who
    // the caller is in the terms it works in.
    participant: options.participant ?? candidate.session.participantId });

  // Named a session but not the generation: the id is in `acc status --json`,
  // so this is what an agent reaches for first, and refusing it would teach the
  // wrong lesson about which half is secret.
  if (options.session !== undefined) {
    // The reads never needed a generation, and a session opened by `acc attach`
    // has no binding to find one in. Answering for the session it was given is
    // both what it was asked and what it did before this resolver existed.
    if (soft) return options;
    const named = candidates.find(candidate => candidate.accSessionId === options.session);
    if (named !== undefined) return take(named);
    throw new AccError(EXIT.USAGE,
      `no live session ${options.session} in this workspace`,
      { command, session: options.session });
  }

  // The documented pair, honoured for anyone who has wired it up themselves.
  if (typeof env.ACC_SESSION === "string" && typeof env.ACC_GENERATION === "string") {
    return { ...options, session: env.ACC_SESSION, generation: env.ACC_GENERATION };
  }

  // The client's own session id, under whatever name it exports it. Claude Code
  // sets CLAUDE_CODE_SESSION_ID, measured equal to the `session_id` its hooks
  // receive; matching on the value rather than the variable name means a client
  // that names it something else works without ACC knowing the name.
  const exported = new Set(Object.values(env).filter(value => typeof value === "string"));
  const byEnvironment = candidates
    .filter(candidate => exported.has(candidate.harnessSessionId));
  if (byEnvironment.length === 1) return take(byEnvironment[0]);

  // Two agents in one workspace are the normal case, and each is usually in its
  // own checkout - that is what the worktree story is. Same repository, so the
  // same workspace, and the checkout tells them apart.
  const here = context.descriptor.git?.worktreeRoot;
  const byCheckout = here === undefined
    ? []
    : candidates.filter(candidate => candidate.session.checkoutRoot === here);
  if (byCheckout.length === 1) return take(byCheckout[0]);

  if (candidates.length === 1) return take(candidates[0]);

  // Guessing between two live sessions would let one agent act as another, which
  // is exactly what the generation exists to prevent. So this refuses, and says
  // what it found.
  if (soft) return options;
  throw new AccError(EXIT.USAGE, candidates.length === 0
    ? `${command} could not tell which session is running it: no live session is `
      + "attached here. An adapter attaches one at SessionStart; `acc status` shows who is."
    : `${command} could not tell which of ${candidates.length} live sessions is running `
      + `it (${describe(candidates)}). Pass --session, which \`acc status --json\` lists.`,
  { command, candidates: candidates.map(candidate => candidate.accSessionId) });
}
