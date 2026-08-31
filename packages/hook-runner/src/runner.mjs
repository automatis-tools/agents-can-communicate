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

import { resolveClientPid } from "./client-pid.mjs";
import { readProcessTable as defaultReadProcessTable } from "./process-table.mjs";

// Kept cohesive above 300 lines because every handler shares one fail-open
// hook boundary, binding lifecycle, and client-specific outcome contract.
// Splitting handlers would duplicate that safety boundary and make delivery or
// guard failures behave differently by event kind.

// A hook runs in front of the user's turn, so it gets a hard ceiling. Better to
// let a call through than to make someone's session sit waiting on us.
const DEFAULT_BUDGET_MS = 5_000;

// Declared by this process on the session it opens, so peers can tell an idle
// session from a dead one. Only one of the four clients fires a heartbeat event,
// so the rest refresh here: on every turn, and during a long one whenever the
// last sign of life is older than half the cadence.
//
// Until they did, a session went stale three minutes after it started and stayed
// stale however hard it was working. Every roster showed every peer as stale, so
// the word stopped meaning anything - and a requester was told "nobody is
// working on it" about work a peer had accepted and was doing.
const CADENCE_MS = 60_000;
const REFRESH_AFTER_MS = CADENCE_MS / 2;

/**
 * Whether the write guard should spend a write saying this session is alive.
 *
 * A value that is not a timestamp means nothing is known about its last sign of
 * life, so it gets one. Said outright rather than left to `Date.parse`: the
 * previous form leaned on `Date.parse(0)` coercing to the string "0" and landing
 * in the year 2000, which gives the right answer and reads like an accident,
 * because it is one.
 */
export function needsRefresh(heartbeatAt, now) {
  const last = Date.parse(heartbeatAt ?? "");
  return !Number.isFinite(last) || now - last > REFRESH_AFTER_MS;
}

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
  async sessionStart({ event, context, adapter, adapterId, binding, paths,
    readProcessTable }) {
    const capabilities = adapter.capabilities ?? {};
    // Once per session, never per turn. A client that cannot be found yields
    // null, and the session is then judged by age alone - which is exactly the
    // behaviour every session had before this existed.
    const command = adapter.client?.command ?? null;
    const pid = command === null ? null
      : resolveClientPid({ table: await readProcessTable(), from: process.pid, command });
    const metadata = {
      pid,
      enforcement: capabilities.guards?.beforeWrite === true ? "guarded" : "advisory",
      lifecycle: capabilities.lifecycle?.sessionEnd === true ? "managed" : "manual",
      heartbeatCadenceMs: CADENCE_MS,
      checkoutRoot: context.descriptor.git?.worktreeRoot ?? context.descriptor.roots[0],
      branch: context.descriptor.git?.branch ?? null,
    };
    if (binding !== null) {
      const resumed = await context.service.resumeSession({
        sessionId: binding.accSessionId,
        generation: binding.generation,
        ...metadata,
      });
      if (resumed !== null) {
        return { accSessionId: resumed.sessionId, generation: resumed.generation };
      }
    }
    const session = await context.service.openSession({
      workspaceId: context.descriptor.id,
      participantId: participantFor(adapterId, event.sessionId, context.env),
      displayName: participantFor(adapterId, event.sessionId, context.env),
      harness: adapterId,
      parentSessionId: null,
      // Declared from what this adapter proved, not from the fact that it is an
      // adapter at all. A peer reading the roster can then tell a session whose
      // writes can be stopped from one whose cannot.
      // Which checkout this agent is in. One workspace spans every worktree of
      // a repository, so this is the only thing that distinguishes them.
      ...metadata,
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
    // A turn is the clearest sign a session is alive. Never a reason to fail:
    // this runs in front of somebody's prompt.
    await context.service.heartbeatSession({ sessionId: binding.accSessionId,
      generation: binding.generation }).catch(() => null);
    const sync = await context.service.sync({ sessionId: binding.accSessionId,
      cursor: null, scope: "delta" });

    // Sync already carries the roster. Calling collectStatus here used to read
    // the entire materialised store a second time on every prompt merely to
    // rediscover this session's participant id.
    const mine = sync.roster
      .find(participant => participant.sessionId === binding.accSessionId);

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
    const tracksDelivery = typeof adapter.renderContextResult === "function";
    const projectionInput = { ...sync, messages: tracksDelivery ? messages : [],
      currentParticipantId: mine?.participantId };
    const projectionOptions = {
      budgetBytes: context.descriptor.policy?.contextBudgetBytes };
    // Delivery is state, not text parsing. Peer-controlled bodies can imitate
    // another message's visible header, so only projector metadata proves
    // which complete groups survived the byte budget. A custom adapter without
    // metadata may still inject text, but cannot advance a receipt from it.
    const projection = !tracksDelivery
      ? { text: await adapter.renderContext?.(projectionInput, projectionOptions) ?? "",
        includedMessageIds: [], includedAttentionIds: [] }
      : await adapter.renderContextResult(projectionInput, projectionOptions);
    const degradation = !tracksDelivery && messages.length > 0
      ? `acc: ${messages.length} pending message(s) withheld because this adapter lacks `
        + `structured delivery metadata; read ${messages[0].messageId} with `
        + `acc inbox --message ${messages[0].messageId}`
      : null;
    const visibleDegradation = degradation === null ? "" : `ACC: ${degradation.slice(5)}`;
    const candidate = [projection.text, visibleDegradation].filter(Boolean).join("\n");
    const projected = Buffer.byteLength(candidate, "utf8")
      <= (projectionOptions.budgetBytes ?? 6_000) ? candidate : projection.text;
    if (projected === "") {
      return degradation === null ? { stdout: "" } : { stdout: "", stderr: degradation };
    }

    // Only what the model was actually shown is recorded as delivered. The
    // budget can leave a message out, and a receipt reading `injected` for text
    // nobody saw is worse than one still reading `queued` - the sender would be
    // told it landed. A message left behind stays queued and goes out next turn.
    const failures = [];
    const includedMessages = new Set(projection.includedMessageIds ?? []);
    for (const message of messages) {
      if (!includedMessages.has(message.messageId)) continue;
      await context.service.markDelivery({ sessionId: binding.accSessionId,
        generation: binding.generation, messageId: message.messageId,
        recipientParticipantId: mine.participantId, state: "injected" })
        .catch(error => failures.push(`${message.messageId}: ${error.message}`));
    }
    // A note carries no ack obligation, so after its one full showing it leaves
    // a single low-priority `unread_note` breadcrumb. Advancing that receipt
    // injected -> seen the turn the breadcrumb is shown is what makes it
    // one-shot: next turn the note reads `seen`, the breadcrumb stays quiet, and
    // a delivered decision is recoverable without becoming a standing nag - the
    // noise a reader learns to skip. Only what was actually shown is advanced,
    // for the same reason the loop above only records what fit.
    const includedAttention = new Set(projection.includedAttentionIds ?? []);
    for (const item of sync.attention ?? []) {
      if (item.kind !== "unread_note") continue;
      if (!includedAttention.has(item.sourceId)) continue;
      await context.service.markDelivery({ sessionId: binding.accSessionId,
        generation: binding.generation, messageId: item.sourceId,
        recipientParticipantId: mine.participantId, state: "seen" })
        .catch(error => failures.push(`${item.sourceId}: ${error.message}`));
    }
    // Same again: Kimi Code shows the model a hook's raw stdout, while Gemini
    // and Claude Code want an envelope and drop a bare string.
    // Reported rather than swallowed. The context still goes out - losing it
    // over bookkeeping would be the worse trade - but a receipt that failed to
    // advance has to be visible somewhere, and stdout belongs to the model.
    const outcome = { stdout: "", ...adapter.injectOutcome?.(projected) };
    if (failures.length === 0 && degradation === null) return outcome;
    return { ...outcome,
      stderr: [outcome.stderr, degradation,
        failures.length === 0 ? null
          : `acc: delivery not recorded for ${failures.join(", ")}`]
        .filter(Boolean).join("\n") };
  },

  async beforeTool({ binding, context, event, adapter }) {
    if (binding === null) return { decision: "allow" };
    if (event.targets.length === 0) {
      // The runner cannot tell what a shell command touches. Saying so is the
      // honest answer; guessing would block work at random and miss real writes.
      return { decision: "allow", unguarded: true };
    }

    // The narrow read: who holds a live claim, and what that owner is called.
    // `collectStatus` answers a person's question and reads the whole store,
    // which put the cost of guarding one write in proportion to every message
    // the workspace had ever carried. This runs in front of every file an agent
    // writes, and the budget that keeps it from failing open is five seconds.
    const status = await context.service.guardState({
      workspaceId: context.descriptor.id });
    // A turn that runs for half an hour is one turn, and a session working that
    // hard should not look dead to its peers. Written at most twice a cadence,
    // so guarding a write stays a read in the ordinary case.
    const mine = status.participants
      .find(participant => participant.sessionId === binding.accSessionId);
    if (mine !== undefined && needsRefresh(mine.heartbeatAt, Date.now())) {
      await context.service.heartbeatSession({ sessionId: binding.accSessionId,
        generation: binding.generation }).catch(() => null);
    }
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
  runtime = defaultRuntime(), budgetMs = DEFAULT_BUDGET_MS,
  readProcessTable = defaultReadProcessTable }) {
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
      : handler({ event, context, adapter, adapterId, binding, paths: context.paths,
        readProcessTable });

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
