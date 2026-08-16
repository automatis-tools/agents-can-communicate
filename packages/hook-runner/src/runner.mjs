import { randomBytes } from "node:crypto";
import path from "node:path";

import { clearSessionBinding, loadSessionBinding, storeSessionBinding }
  from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { createId } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { createGitProbe, discoverWorkspace, platformDataHome, runtimePaths }
  from "@agents-can-communicate/cli";

// A hook runs in front of the user's turn, so it gets a hard ceiling. Better to
// let a call through than to make someone's session sit waiting on us.
const DEFAULT_BUDGET_MS = 5_000;

// Declared by this process on the session it opens, so peers can tell an idle
// session from a dead one. Adapters whose client fires no heartbeat still get a
// truthful cadence: they refresh on every turn instead.
const CADENCE_MS = 60_000;

const defaultRuntime = () => ({
  clock: { now: () => new Date().toISOString() },
  ids: { next: kind => createId(kind, randomBytes) },
});

/**
 * Map an absolute path to the resource identifier claims are written against.
 *
 * Returns null when the path is not inside the workspace. Relativising it
 * anyway is the tempting bug: `/etc/src/a.mjs` would become `src/a.mjs` and be
 * blocked by a claim on this workspace's `src/**`, which never covered it.
 */
export function resourceFor(root, target) {
  const absolute = path.isAbsolute(target) ? target : path.resolve(root, target);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return `file:${relative.split(path.sep).join("/")}`;
}

// Same rule as the core's claim overlap, applied to a concrete path: a claim on
// `file:src/**` covers `file:src/a.mjs`, and `file:srcx/a.mjs` is not inside it.
export const covers = (resource, target) => {
  if (resource === target) return true;
  if (!resource.endsWith("/**")) return false;
  const prefix = resource.slice(0, -3);
  return target === prefix || target.startsWith(`${prefix}/`);
};

async function openContext({ cwd, dataHome, runtime, env }) {
  const descriptor = await discoverWorkspace({ cwd, env: env ?? {},
    gitProbe: createGitProbe() });
  const paths = runtimePaths({
    dataHome: dataHome ?? platformDataHome({ env: env ?? {} }),
    workspaceId: descriptor.id,
    workspaceRoots: descriptor.roots,
  });
  const store = await openFilesystemStore({ root: paths.root, clock: runtime.clock,
    ids: runtime.ids, workspaceId: descriptor.id });
  return { descriptor, paths,
    service: createCoordinationService({ store, clock: runtime.clock, ids: runtime.ids }) };
}

const HANDLERS = {
  async sessionStart({ event, context, adapter, adapterId, paths }) {
    const capabilities = adapter.capabilities ?? {};
    const session = await context.service.openSession({
      workspaceId: context.descriptor.id,
      participantId: adapterId,
      displayName: adapterId,
      harness: adapterId,
      parentSessionId: null,
      // Declared from what this adapter proved, not from the fact that it is an
      // adapter at all. A peer reading the roster can then tell a session whose
      // writes can be stopped from one whose cannot.
      enforcement: capabilities.guards?.beforeWrite === true ? "guarded" : "advisory",
      lifecycle: capabilities.lifecycle?.sessionEnd === true ? "managed" : "manual",
      heartbeatCadenceMs: CADENCE_MS,
      descriptor: context.descriptor,
    });
    await storeSessionBinding({ runtimeDir: paths.root, harnessSessionId: event.sessionId,
      accSessionId: session.sessionId, generation: session.generation });
    return { accSessionId: session.sessionId, generation: session.generation };
  },

  async heartbeat({ binding, context }) {
    if (binding === null) return {};
    await context.service.heartbeatSession({ sessionId: binding.accSessionId,
      generation: binding.generation });
    return {};
  },

  async sessionEnd({ binding, context, event, paths }) {
    if (binding === null) return {};
    await context.service.closeSession({ sessionId: binding.accSessionId,
      generation: binding.generation });
    await clearSessionBinding({ runtimeDir: paths.root, harnessSessionId: event.sessionId });
    return {};
  },

  async beforeTurn({ binding, context, adapter }) {
    if (binding === null) return {};
    const sync = await context.service.sync({ sessionId: binding.accSessionId,
      cursor: null, scope: "delta" });
    // Solo costs nothing: nothing to say means nothing printed, not a banner
    // announcing that nobody else is here.
    if (sync.solo) return { stdout: "" };

    // Claims held by others, and whether this session can actually be stopped
    // from breaking them. For a harness that guards writes this is useful
    // warning; for one that cannot - a Codex model editing through the shell,
    // an MCP client - it is the only protection there is, so it has to say
    // plainly that the responsibility has moved to the session itself.
    const status = await context.service.collectStatus({
      workspaceId: context.descriptor.id });
    const mine = status.participants
      .find(participant => participant.sessionId === binding.accSessionId);
    // Two independent facts, and both are needed. `enforceable` is whether ACC
    // could stop *this* session at all; `enforcement` is what the claim's owner
    // asked for. A guarded session facing an advisory claim is not blocked from
    // anything, so reporting either one alone mislabels the other case.
    const enforceable = mine?.enforcement === "guarded";
    const claims = status.claims
      .filter(claim => claim.ownerSessionId !== binding.accSessionId)
      .map(claim => ({ resource: claim.resource, enforcement: claim.enforcement,
        enforceable,
        ownerParticipantId: status.participants
          .find(p => p.sessionId === claim.ownerSessionId)?.participantId
          ?? claim.ownerSessionId }));

    // What peers have said to this participant and no model has been shown yet.
    // Without this the projector's peer block never ran in production: an agent
    // saw only the subject of a message through its attention line, and the
    // `injected` delivery state was unreachable.
    const messages = await context.service.pendingMessages({
      workspaceId: context.descriptor.id,
      participantId: mine?.participantId,
      exceptSessionId: binding.accSessionId });

    // The ceiling a team agreed on in `acc.workspace.json`, or the default when
    // there is no config. Validated by the protocol and, until now, never read:
    // the projector was always called with its own default.
    const projected = await adapter.renderContext?.({ ...sync, claims, messages },
      { budgetBytes: context.descriptor.policy?.contextBudgetBytes }) ?? "";
    if (projected === "") return { stdout: "" };

    // Only what the model was actually shown is recorded as delivered. The
    // budget can leave a message out, and a receipt reading `injected` for text
    // nobody saw is worse than one still reading `queued` - the sender would be
    // told it landed. A message left behind stays queued and goes out next turn.
    const failures = [];
    for (const message of messages) {
      if (!projected.includes(message.messageId)) continue;
      await context.service.markDelivery({ sessionId: binding.accSessionId,
        generation: binding.generation, messageId: message.messageId,
        recipientParticipantId: mine.participantId, state: "injected" })
        .catch(error => failures.push(`${message.messageId}: ${error.message}`));
    }
    // Same again: Kimi Code shows the model a hook's raw stdout, while Gemini
    // and Claude Code want an envelope and drop a bare string.
    // Reported rather than swallowed. The context still goes out - losing it
    // over bookkeeping would be the worse trade - but a receipt that failed to
    // advance has to be visible somewhere, and stdout belongs to the model.
    const outcome = { stdout: "", ...adapter.injectOutcome?.(projected) };
    if (failures.length === 0) return outcome;
    return { ...outcome,
      stderr: [outcome.stderr, `acc: delivery not recorded for ${failures.join(", ")}`]
        .filter(Boolean).join("\n") };
  },

  async beforeTool({ binding, context, event, adapter }) {
    if (binding === null) return { decision: "allow" };
    if (event.targets.length === 0) {
      // The runner cannot tell what a shell command touches. Saying so is the
      // honest answer; guessing would block work at random and miss real writes.
      return { decision: "allow", unguarded: true };
    }

    const status = await context.service.collectStatus({
      workspaceId: context.descriptor.id });
    const root = context.descriptor.roots[0];
    const wanted = event.targets
      .map(target => resourceFor(root, target))
      .filter(resource => resource !== null);

    const blocking = status.claims.find(claim =>
      claim.enforcement === "guarded"
      && claim.ownerSessionId !== binding.accSessionId
      && wanted.some(resource => covers(claim.resource, resource)));

    if (blocking === undefined) return { decision: "allow" };
    const owner = status.participants
      .find(participant => participant.sessionId === blocking.ownerSessionId);
    const reason = `${blocking.resource} is claimed by ${owner?.participantId
      ?? blocking.ownerSessionId} (session ${blocking.ownerSessionId})`;
    // How a denial is expressed is the adapter's business, and the four do not
    // agree on the modality, let alone the shape: three answer with JSON on
    // stdout, Codex denies by exiting 2 with the reason on stderr.
    return { decision: "deny", ...adapter.denyOutcome(reason) };
  },
};

/**
 * Run one hook invocation.
 *
 * Every failure path ends in "allow, exit 0". A coordination tool that can stop
 * someone's session from working is worse than no coordination at all, so the
 * only thing this function refuses to do is fail closed.
 */
export async function runHook({ adapterId, payload, adapters, dataHome, env,
  runtime = defaultRuntime(), budgetMs = DEFAULT_BUDGET_MS }) {
  const result = { stdout: "", exitCode: 0, decision: "allow", sessions: [] };
  let timer = null;
  try {
    const adapter = adapters?.[adapterId];
    if (adapter === undefined) throw new Error(`no adapter named ${adapterId}`);

    const event = await adapter.normalizeHook(payload);
    const context = await openContext({ cwd: event.cwd, dataHome, runtime, env });
    const binding = await loadSessionBinding({ runtimeDir: context.paths.root,
      harnessSessionId: event.sessionId }).catch(() => null);

    const handler = HANDLERS[event.kind];
    const work = handler === undefined
      ? Promise.resolve({})
      : handler({ event, context, adapter, adapterId, binding, paths: context.paths });

    // The loser of a race is not cancelled, so the timer is cleared explicitly:
    // an outstanding one keeps the process alive long past its answer.
    const budget = new Promise(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
    });
    Object.assign(result, await Promise.race([work, budget]));

    const status = await context.service.collectStatus({
      workspaceId: context.descriptor.id });
    result.sessions = status.participants.filter(p => p.presence !== "offline");
    result.service = context.service;
  } catch (error) {
    result.failed = true;
    result.reason = error.message;
    result.decision = "allow";
    result.stdout = "";
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  return result;
}
