import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
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
  // Injected rather than imported at the call site so a test can drive the
  // resolution without needing a real symlink on the filesystem it runs on.
  realpath,
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

/**
 * The same path, spelled the way the workspace root is spelled.
 *
 * Discovery resolves its root through `realpath`, so the descriptor is always
 * canonical. A hook payload is not: it carries whatever the client had, and a
 * client's cwd is whatever the human typed. When the two differ only by a
 * symlinked ancestor - `/tmp` and `/var` on macOS, a symlinked checkout
 * anywhere - `resourceFor` relativised to `../..`, the target list emptied, and
 * every write was allowed while `acc status` still said `protection guarded`.
 *
 * The leaf usually does not exist yet, because the tool call being guarded is
 * what would create it. So the deepest existing ancestor is resolved and the
 * remainder appended, which is also what keeps this from following a symlink
 * the write itself would replace.
 *
 * A relative target is resolved against `base` - the session's own cwd, as the
 * payload states it - and never against this process's. A hook is a child whose
 * working directory belongs to the client, and Codex's `apply_patch` names its
 * files relative to the session. Resolving those against wherever the hook
 * happened to start sent them outside the workspace, `resourceFor` returned
 * null, and every write was allowed while `acc status` said `protection
 * guarded`. It only ever worked because a client usually starts hooks in the
 * project directory - and "usually" is what made it invisible.
 */
export async function canonicalTarget(realpath, target, base = process.cwd()) {
  let current = path.resolve(base, target);
  const trailing = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...trailing);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return path.resolve(base, target);
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists. The
      // unresolved path is the best answer available, and `resourceFor` will
      // reject it if it is outside the workspace.
      if (parent === current) return path.resolve(base, target);
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
}

// Same rule as the core's claim overlap, applied to a concrete path: a claim on
// `file:src/**` covers `file:src/a.mjs`, and `file:srcx/a.mjs` is not inside it.
export const covers = (resource, target) => {
  if (resource === target) return true;
  if (!resource.endsWith("/**")) return false;
  const prefix = resource.slice(0, -3);
  return target === prefix || target.startsWith(`${prefix}/`);
};

// A participant is one running agent, not one brand of client. Two Codex
// sessions are two agents even in the same directory, so identity cannot be
// derived from where they run - deriving it from the branch made two agents in
// one checkout indistinguishable again.
//
// The default distinguishes them by the client's own session, which is stable
// for as long as that agent is running and changes when it restarts. An agent
// meant to be addressable across restarts is named by whoever launches it:
//
//   ACC_PARTICIPANT=backend-codex codex
//
// Work is addressed to a participant, so a pinned name is what makes a request
// survive the recipient closing its terminal.
const PORTABLE = /[^A-Za-z0-9._-]+/g;

export function participantFor(adapterId, harnessSessionId, env = {}) {
  const declared = env.ACC_PARTICIPANT;
  if (typeof declared === "string" && declared.trim() !== "") {
    return declared.trim().replace(PORTABLE, "-").slice(0, 60);
  }
  const suffix = createHash("sha256").update(String(harnessSessionId))
    .digest("base64url").slice(0, 6);
  return `${adapterId}-${suffix}`;
}

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
  return { descriptor, paths, env: env ?? {}, realpath: runtime.realpath ?? realpath,
    service: createCoordinationService({ store, clock: runtime.clock, ids: runtime.ids }) };
}

const HANDLERS = {
  async sessionStart({ event, context, adapter, adapterId, paths }) {
    const capabilities = adapter.capabilities ?? {};
    const session = await context.service.openSession({
      workspaceId: context.descriptor.id,
      participantId: participantFor(adapterId, event.sessionId, context.env),
      displayName: participantFor(adapterId, event.sessionId, context.env),
      harness: adapterId,
      parentSessionId: null,
      // Declared from what this adapter proved, not from the fact that it is an
      // adapter at all. A peer reading the roster can then tell a session whose
      // writes can be stopped from one whose cannot.
      enforcement: capabilities.guards?.beforeWrite === true ? "guarded" : "advisory",
      lifecycle: capabilities.lifecycle?.sessionEnd === true ? "managed" : "manual",
      heartbeatCadenceMs: CADENCE_MS,
      // Which checkout this agent is in. One workspace spans every worktree of
      // a repository, so this is the only thing that distinguishes them.
      checkoutRoot: context.descriptor.git?.worktreeRoot ?? context.descriptor.roots[0],
      branch: context.descriptor.git?.branch ?? null,
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

    // Solo costs nothing: nothing to say means nothing printed, not a banner
    // announcing that nobody else is here. But something already said to you is
    // not nothing - the check used to run before the inbox was read, so the
    // answer to your own request vanished the moment the agent working on it
    // closed and left you as the only session.
    if (sync.solo && messages.length === 0) return { stdout: "" };

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
    // Anchored to the repository, not to wherever this session was started. A
    // session opened in `repo/src` relativised the same file to
    // `file:physics.mjs` where one at `repo` called it `file:src/physics.mjs`,
    // so a claim on either did not cover the other and both agents edited it
    // freely. Repository-relative is also the convention every documented claim
    // already uses - `file:packages/core/**` means one thing in a project.
    //
    // A declared config is the exception: its roots are the stated boundary, and
    // they may deliberately not be the checkout.
    const root = context.descriptor.source === "git" && context.descriptor.git !== undefined
      ? context.descriptor.git.worktreeRoot
      : context.descriptor.roots[0];
    const resolved = await Promise.all(event.targets
      .map(target => canonicalTarget(context.realpath, target, event.cwd)));
    const wanted = resolved
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
