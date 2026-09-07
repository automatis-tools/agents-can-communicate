import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { clearSessionBinding, effectiveCapabilities, loadSessionBinding, storeSessionBinding }
  from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { assertPortableId, createId } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { createGitProbe, discoverWorkspace, platformDataHome, runtimePaths }
  from "@agents-can-communicate/cli";

import { resolveClientPid } from "./client-pid.mjs";
import { probeClientVersion as defaultProbeClientVersion } from "./client-version.mjs";
import { establishNativeBinding, livePolicyFrom } from "./native-binding.mjs";
import { readProcessTable as defaultReadProcessTable } from "./process-table.mjs";
import { withSessionLifecycle } from "./session-lifecycle.mjs";

// Kept cohesive above 300 lines because every handler shares one fail-open
// hook boundary, binding lifecycle, and client-specific outcome contract.
// Splitting handlers would duplicate that safety boundary and make delivery or
// guard failures behave differently by event kind.

// A hook runs in front of the user's turn, so it gets a hard ceiling. Better to
// let a call through than to make someone's session sit waiting on us.
const DEFAULT_BUDGET_MS = 5_000;

function assertHookBudget(deadline, message = "hook deadline expired") {
  if (Date.now() >= deadline) throw new Error(message);
}

const byteLength = value => Buffer.byteLength(value, "utf8");

function compactInboxRecovery(messages) {
  const first = messages[0].messageId;
  const rest = messages.length > 1 ? ` (+${messages.length - 1} more in \`acc inbox\`)` : "";
  return `ACC: read pending peer message: \`acc inbox --message ${first}\`${rest}`;
}

function fitDegradation(projection, visibleDegradation, messages, budgetBytes) {
  const full = [projection, visibleDegradation].filter(Boolean).join("\n");
  if (byteLength(full) <= budgetBytes) return full;
  const recovery = compactInboxRecovery(messages);
  const exactRecovery = compactInboxRecovery(messages.slice(0, 1));
  const withRecovery = [projection, recovery].filter(Boolean).join("\n");
  if (byteLength(withRecovery) <= budgetBytes) return withRecovery;
  const withExactRecovery = [projection, exactRecovery].filter(Boolean).join("\n");
  if (byteLength(withExactRecovery) <= budgetBytes) return withExactRecovery;
  if (byteLength(recovery) <= budgetBytes) return recovery;
  if (byteLength(exactRecovery) <= budgetBytes) return exactRecovery;
  return projection;
}

function ownerOnlyOutcome(adapter, owner, budgetBytes) {
  if (byteLength(owner) > budgetBytes) {
    return { stdout: "", stderr: "acc: context budget cannot fit owner arguments; increase contextBudgetBytes" };
  }
  return { stdout: "", ...adapter.injectOutcome?.(owner) };
}

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

async function openContext({ cwd, dataHome, runtime, env, deadline }) {
  assertHookBudget(deadline);
  const descriptor = await discoverWorkspace({ cwd, env: env ?? {},
    gitProbe: createGitProbe({ deadlineAt: deadline }) });
  assertHookBudget(deadline);
  const paths = runtimePaths({
    dataHome: dataHome ?? platformDataHome({ env: env ?? {} }),
    workspaceId: descriptor.id,
    workspaceRoots: descriptor.roots,
  });
  const store = await openFilesystemStore({ root: paths.root, clock: runtime.clock,
    ids: runtime.ids, workspaceId: descriptor.id, deadlineAt: deadline });
  return { descriptor, paths, env: env ?? {}, realpath: runtime.realpath ?? realpath,
    service: createCoordinationService({ store, clock: runtime.clock, ids: runtime.ids }) };
}

// What this turn is shown and which complete groups it may commit as
// offered. Runs after the heartbeat and the bounded native retry.
async function projectTurn({ binding, context, adapter, adapterId }) {
  const sync = await context.service.sync({ sessionId: binding.accSessionId,
    cursor: null, scope: "delta" });

  // Sync already carries the roster. Calling collectStatus here used to read
  // the entire materialised store a second time on every prompt merely to
  // rediscover this session's participant id.
  const mine = sync.roster
    .find(participant => participant.sessionId === binding.accSessionId);

  // What peers have said to this participant and no model has been shown yet.
  // Without this the projector's peer block never runs in production: an
  // agent sees only the obligation attention line, not the durable body that
  // may be offered after the stdout transport succeeds.
  const delivery = await context.service.nextTurnDelivery({
    workspaceId: context.descriptor.id,
    participantId: mine?.participantId,
    exceptSessionId: binding.accSessionId });
  const messages = delivery.queuedMessages;

  // Only this hook's payload selected the binding. Supply its own pair as
  // trusted context, outside peer bodies, rather than exporting inheritable
  // credentials or teaching the CLI to guess from a public roster.
  const owner = "ACC CLI (append): --session "
    + assertPortableId(binding.accSessionId, "sessionId") + " --generation "
    + assertPortableId(binding.generation, "generation");
  const totalBudget = context.descriptor.policy?.contextBudgetBytes ?? 6_000;
  // A peer can join after this prompt has begun. The current turn must already
  // have its own arguments when it needs inbox/reply, without reattaching or
  // waiting for another user prompt. Solo emits identity, not a peer notice.
  if (sync.solo && messages.length === 0) {
    return ownerOnlyOutcome(adapter, owner, totalBudget);
  }

  // The ceiling a team agreed on in `acc.workspace.json`, or the default when
  // there is no config. Validated by the protocol and, until now, never read:
  // the projector was always called with its own default.
  const effective = effectiveCapabilities(adapter, binding);
  const hasStructuredRenderer = typeof adapter.renderContextResult === "function";
  const canOfferNextTurn = effective.delivery.nextTurn === true && hasStructuredRenderer;
  const projectionInput = { ...sync, messages: canOfferNextTurn ? messages : [],
    liveOfferedMessageIds: delivery.liveOfferedMessageIds,
    roomMessageIds: delivery.roomMessageIds,
    currentParticipantId: mine?.participantId };
  // Credentials alone cannot replace the command that reaches a queued body.
  // If both cannot fit, preserve recovery and explain the missing owner pair.
  const minimumBodyBytes = messages.length === 0 ? 1
    : byteLength(compactInboxRecovery(messages.slice(0, 1)));
  const ownerFits = byteLength(owner) + 1 + minimumBodyBytes <= totalBudget;
  const ownerWarning = ownerFits ? null
    : "acc: context budget cannot fit owner arguments with coordination context; increase contextBudgetBytes";
  const projectionOptions = {
    budgetBytes: ownerFits ? totalBudget - byteLength(owner) - 1 : totalBudget };
  // Delivery is state, not text parsing. Peer-controlled bodies can imitate
  // another message's visible header, so only projector metadata proves
  // which complete groups survived the byte budget. A custom adapter without
  // metadata may still inject text, but cannot advance a receipt from it.
  const projection = !hasStructuredRenderer
    ? { text: await adapter.renderContext?.(projectionInput, projectionOptions) ?? "",
      offeredMessageIds: [], includedAttentionIds: [] }
    : await adapter.renderContextResult(projectionInput, projectionOptions);
  const clientFactsKnown = typeof binding.clientVersion === "string"
    && typeof binding.platform === "string";
  const reason = !effective.delivery.nextTurn
    ? clientFactsKnown
      ? `client ${binding.clientVersion} on ${binding.platform} is not certified for nextTurn`
      : "the client version or platform is unknown"
    : !hasStructuredRenderer ? "this adapter lacks structured delivery metadata" : null;
  const degradation = reason !== null && messages.length > 0
    ? `acc: ${messages.length} pending message(s) withheld because ${reason}; read `
      + `${messages[0].messageId} with acc inbox --message ${messages[0].messageId}` : null;
  const visibleDegradation = degradation === null ? "" : `ACC: ${degradation.slice(5)}`;
  const budgetBytes = projectionOptions.budgetBytes ?? 6_000;
  const body = degradation === null ? projection.text
    : fitDegradation(projection.text, visibleDegradation, messages, budgetBytes);
  // Own claims make sync non-solo but produce no peer context. They cannot
  // remove this turn's identity or consume a nonexistent body separator.
  if (body === "" && messages.length === 0) return ownerOnlyOutcome(adapter, owner, totalBudget);
  const projected = body === "" ? "" : ownerFits ? `${owner}\n${body}` : body;
  if (projected === "") {
    return { stdout: "", stderr: messages.length === 0 ? ""
      : [ownerWarning, degradation].filter(Boolean).join("\n") };
  }

  // The renderer returns ids as metadata, never as text to parse. A peer body
  // can imitate every visible label, so only a complete group selected by the
  // projector is eligible for the post-write offer commit.
  const offered = new Set(canOfferNextTurn ? projection.offeredMessageIds ?? [] : []);
  const offerInputs = messages.filter(message => offered.has(message.messageId))
    .map(message => ({ messageId: message.messageId,
      recipientParticipantId: mine.participantId,
      targetSessionId: binding.accSessionId, targetGeneration: binding.generation,
      transport: "next-turn", adapterId,
      clientVersion: binding.clientVersion }));
  // Same again: Kimi Code shows the model a hook's raw stdout, while Gemini
  // and Claude Code want an envelope and drop a bare string.
  // The entry point owns the transport boundary. This handler only prepares
  // offer inputs; recording them here would claim delivery before stdout's
  // callback proves that the bytes crossed.
  const outcome = { stdout: "", ...adapter.injectOutcome?.(projected) };
  const writableOffers = outcome.stdout === "" ? [] : offerInputs;
  return { ...outcome,
    stderr: [outcome.stderr, ownerWarning, degradation].filter(Boolean).join("\n"),
    offerInputs: writableOffers };
}

// One bounded, fail-open native handshake for this exact session generation.
// The policy comes only from the environment an owned shell bootstrap
// exported; an ordinary launch has none and stays durable.
async function bindNative({ adapter, event, hookBinding, clientVersion, platform, context, paths,
  deadline }) {
  assertHookBudget(deadline);
  return establishNativeBinding({ adapter, event, hookBinding, clientVersion, platform,
    livePolicy: livePolicyFrom(context.env), service: context.service, runtimeDir: paths.root,
    clock: context.service.clock,
    timeoutMs: Math.max(1, Math.min(750, deadline - Date.now())) });
}

const HANDLERS = {
  async sessionStart({ event, context, adapter, adapterId, binding, paths,
    readProcessTable, probeClientVersion, platform, deadline }) {
    // A repeated start refreshes the client's version/platform. Remove the old
    // certified facts before any probe, PID lookup, resume, or open can fail;
    // keep only the generation identity needed for a successful resume.
    if (binding !== null) {
      await storeSessionBinding({ runtimeDir: paths.root, deadlineAt: deadline, harnessSessionId: event.sessionId,
        accSessionId: binding.accSessionId, generation: binding.generation });
    }
    const clientVersion = await probeClientVersion(adapter,
      { timeoutMs: Math.max(1, Math.min(1_000, deadline - Date.now())) });
    assertHookBudget(deadline);
    const clientFacts = { clientVersion, platform };
    const capabilities = effectiveCapabilities(adapter, clientFacts);
    // Once per session, never per turn. A client that cannot be found yields
    // null, and the session is then judged by age alone - which is exactly the
    // behaviour every session had before this existed.
    const command = adapter.client?.command ?? null;
    const pid = command === null ? null
      : resolveClientPid({ table: await readProcessTable({
        timeoutMs: Math.max(1, Math.min(1_000, deadline - Date.now())) }), from: process.pid, command });
    assertHookBudget(deadline);
    const clientPid = Number.isInteger(pid) && pid > 0 ? pid : undefined;
    const native = hookBinding => bindNative({ adapter, event, hookBinding, ...clientFacts,
      context, paths, deadline });
    const metadata = {
      pid,
      enforcement: capabilities.guards?.beforeWrite === true ? "guarded" : "advisory",
      lifecycle: capabilities.lifecycle?.sessionEnd === true ? "managed" : "manual",
      heartbeatCadenceMs: CADENCE_MS,
      checkoutRoot: context.descriptor.git?.worktreeRoot ?? context.descriptor.roots[0],
      branch: context.descriptor.git?.branch ?? null,
    };
    if (event.kind === "beforeTurn") {
      // A real prompt may continue after finish closed this native owner's
      // record. Recheck after the probes: a CLI replacement can run outside
      // the native lifecycle lock. Never adopt that replacement's identity.
      const previous = await context.service.locateSession(binding.accSessionId);
      if (previous?.record.state !== "closed"
        || previous.record.generation !== binding.generation) {
        throw new Error("the completed hook owner changed during turn registration");
      }
    }
    if (binding !== null) {
      const resumed = await context.service.resumeSession({
        sessionId: binding.accSessionId,
        generation: binding.generation,
        ...metadata,
      });
      if (resumed !== null) {
        const hookBinding = { accSessionId: resumed.sessionId, generation: resumed.generation,
          ...clientFacts, clientPid };
        await storeSessionBinding({ runtimeDir: paths.root, deadlineAt: deadline, harnessSessionId: event.sessionId,
          ...hookBinding });
        return { accSessionId: resumed.sessionId, generation: resumed.generation,
          ...clientFacts, capabilities, nativeBinding: await native(hookBinding) };
      }
    }
    // Persist ownership before creating its session. If the hook dies after
    // creation, the next start resumes this exact pair. If creation never
    // happened (or it was closed), a retry allocates a NEW pair, never revives it.
    const opening = { sessionId: context.service.ids.next("session"),
      generation: context.service.ids.next("generation") };
    await storeSessionBinding({ runtimeDir: paths.root, deadlineAt: deadline, harnessSessionId: event.sessionId,
      accSessionId: opening.sessionId, generation: opening.generation });
    const session = await context.service.openSession({
      ...opening,
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
    const hookBinding = { accSessionId: session.sessionId, generation: session.generation,
      ...clientFacts, clientPid };
    await storeSessionBinding({ runtimeDir: paths.root, deadlineAt: deadline, harnessSessionId: event.sessionId,
      ...hookBinding });
    return { accSessionId: session.sessionId, generation: session.generation,
      ...clientFacts, capabilities, nativeBinding: await native(hookBinding) };
  },

  async heartbeat({ binding, context }) {
    if (binding === null) return {};
    await context.service.heartbeatSession({ sessionId: binding.accSessionId,
      generation: binding.generation });
    return {};
  },

  async sessionEnd({ binding, context, event, paths, deadline }) {
    if (binding === null) return {};
    const owner = { sessionId: binding.accSessionId, generation: binding.generation };
    const current = await context.service.locateSession(binding.accSessionId);
    if (current?.record.generation === binding.generation && current.record.state === "open") {
      await context.service.closeSession(owner);
    } else {
      // Close may have committed before this hook died. Retire only the old
      // endpoint and binding; do not close a replacement or repeat a close event.
      await context.service.clearDeliveryBinding(owner);
    }
    await clearSessionBinding({ runtimeDir: paths.root, deadlineAt: deadline, harnessSessionId: event.sessionId });
    return {};
  },

  async beforeTurn(input) {
    const { binding, context, adapter, event, paths, deadline } = input;
    if (binding === null) return {};
    const current = await context.service.locateSession(binding.accSessionId);
    if (current?.record.state === "closed" && current.record.generation === binding.generation) {
      // finish ends an ACC incarnation, not the native conversation. Only a
      // genuine new user turn can start another one; tool hooks cannot. Reuse
      // the crash-safe opening path, retaining its full published client facts
      // and its single native handshake rather than binding a second time.
      const started = await HANDLERS.sessionStart(input);
      const fresh = await loadSessionBinding({ runtimeDir: paths.root,
        harnessSessionId: event.sessionId });
      const turn = await projectTurn({ ...input, binding: fresh });
      return { ...turn, nativeBinding: started.nativeBinding };
    }
    // A turn is the clearest sign a session is alive. Never a reason to fail:
    // this runs in front of somebody's prompt.
    await context.service.heartbeatSession({ sessionId: binding.accSessionId,
      generation: binding.generation });
    // A native transport that became ready only after SessionStart is picked
    // up here and a live lease is renewed: bounded, fail-open, never on a guard.
    const nativeBinding = livePolicyFrom(context.env) === "off" ? undefined
      : await bindNative({ adapter, event, hookBinding: binding,
        clientVersion: binding.clientVersion, platform: binding.platform, context, paths,
        deadline });
    const turn = await projectTurn(input);
    return nativeBinding === undefined ? turn : { ...turn, nativeBinding };
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
  readProcessTable = defaultReadProcessTable,
  probeClientVersion = defaultProbeClientVersion,
  platform = `${process.platform}-${process.arch}` }) {
  const deadline = Date.now() + budgetMs;
  const fallback = { stdout: "", exitCode: 0, decision: "allow", sessions: [], deadlineAt: deadline,
    commitOffers: async () => {} };
  const execute = async () => {
    assertHookBudget(deadline);
    const adapter = adapters?.[adapterId];
    if (adapter === undefined) throw new Error(`no adapter named ${adapterId}`);

    const event = await adapter.normalizeHook(payload);
    const context = await openContext({ cwd: event.cwd, dataHome, runtime, env, deadline });
    const handler = HANDLERS[event.kind];
    const lifecycle = ["sessionStart", "sessionEnd", "beforeTurn"].includes(event.kind);
    const invoke = async () => {
      assertHookBudget(deadline);
      if (lifecycle) {
        // A previous holder may have died after journalling its session while
        // this process waited. Recover that write before interpreting its binding.
        const store = await openFilesystemStore({ root: context.paths.root, clock: runtime.clock,
          ids: runtime.ids, workspaceId: context.descriptor.id, deadlineAt: deadline });
        context.service = createCoordinationService({ store, clock: runtime.clock, ids: runtime.ids });
      }
      const binding = await loadSessionBinding({ runtimeDir: context.paths.root,
        harnessSessionId: event.sessionId });
      assertHookBudget(deadline);
      return handler === undefined ? {} : handler({ event, context, adapter, adapterId,
        binding, paths: context.paths,
        readProcessTable, probeClientVersion, platform, deadline });
    };
    const work = lifecycle
      ? withSessionLifecycle({ root: context.paths.root, sessionId: event.sessionId,
        clock: runtime.clock, deadlineAt: deadline }, invoke)
      : invoke();
    // Keep the late continuation's result private. Once the budget wins, it
    // cannot change the fail-open answer or restore withdrawn output/offers.
    const result = { ...fallback, ...await work };
    assertHookBudget(deadline);
    const offerInputs = result.offerInputs ?? [];
    let commitPromise = null;
    result.commitOffers = () => {
      if (commitPromise !== null) return commitPromise;
      commitPromise = (async () => {
        for (const input of offerInputs) {
          assertHookBudget(deadline, "hook budget exhausted before offer commit");
          await context.service.recordOfferSucceeded({ ...input, deadlineAt: deadline });
        }
      })();
      return commitPromise;
    };
    delete result.offerInputs;

    const status = await context.service.collectStatus({
      workspaceId: context.descriptor.id });
    assertHookBudget(deadline);
    result.sessions = status.participants.filter(p => p.presence !== "offline");
    result.service = context.service;
    return result;
  };

  let timer;
  try {
    // One budget covers normalization, discovery, recovery, handling and the
    // final status read. Store/binding deadlines fence undecided writes; an
    // activated journal still completes under its writer lock after expiry.
    const budget = new Promise(resolve => {
      timer = setTimeout(() => resolve({ ...fallback, timedOut: true }),
        Math.max(0, deadline - Date.now()));
    });
    return await Promise.race([execute(), budget]);
  } catch (error) {
    return { ...fallback, failed: true, reason: error.message,
      ...(Date.now() >= deadline ? { timedOut: true } : {}) };
  } finally {
    clearTimeout(timer);
  }
}
