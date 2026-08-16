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
  async sessionStart({ event, context, adapterId, paths }) {
    const session = await context.service.openSession({
      workspaceId: context.descriptor.id,
      participantId: adapterId,
      displayName: adapterId,
      harness: adapterId,
      parentSessionId: null,
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
    const projected = await adapter.renderContext?.(sync) ?? "";
    if (projected === "") return { stdout: "" };
    // Same again: Kimi Code shows the model a hook's raw stdout, while Gemini
    // and Claude Code want an envelope and drop a bare string.
    return { stdout: "", ...adapter.injectOutcome?.(projected) };
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
