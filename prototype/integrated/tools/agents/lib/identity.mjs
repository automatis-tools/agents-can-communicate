import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { readJsonStrict, writeJsonAtomic } from "./atomic-json.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { ensureBusLayout } from "./paths.mjs";
import {
  validateAgentId,
  validatePresence,
  validateProtocol,
  validateRegistry,
} from "./schema.mjs";

const STALE_HEARTBEAT_MS = 45_000;

async function readIfPresent(filePath, validate) {
  try {
    return await readJsonStrict(filePath, validate);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRegistryIfPresent(paths, agentId) {
  return readIfPresent(paths.registryFile(agentId), validateRegistry);
}

async function readPresenceIfPresent(paths, agentId) {
  return readIfPresent(paths.presenceFile(agentId), validatePresence);
}

function inputAgentId(input) {
  return validateAgentId(input.agentId ?? input.agent_id);
}

function presenceIsLive(presence, context) {
  if (presence === null || presence.status !== "online") return false;
  const heartbeatAt = Date.parse(presence.heartbeat_at);
  return context.pidIsAlive(presence.pid)
    && context.now().getTime() - heartbeatAt <= STALE_HEARTBEAT_MS;
}

function assertRegistrationAllowed(existing, input, presence, context) {
  if (existing === null) {
    if (input.resume) {
      throw new CommsError("cannot resume an unregistered agent", EXIT.CONFLICT);
    }
    return;
  }
  if (presenceIsLive(presence, context)) {
    throw new CommsError("agent id already has a live watcher", EXIT.CONFLICT);
  }
  if (input.resume && (existing.worktree !== input.worktree || existing.task !== input.task)) {
    throw new CommsError("resume requires the registered worktree and task", EXIT.CONFLICT);
  }
}

function makeRegistryRecord(input, agentId, git, timestamp) {
  return validateRegistry({
    schema_version: 1,
    agent_id: agentId,
    role: input.role,
    task: input.task,
    worktree: input.worktree,
    branch: git.branch,
    head: git.head,
    ownership: input.ownership ?? [],
    ...(input.client === undefined ? {} : { client: input.client }),
    status: "open",
    registered_at: timestamp,
    updated_at: timestamp,
  });
}

async function checkoutIdentity(paths) {
  try {
    const checkoutRoot = await realpath(path.dirname(paths.root));
    const commonDir = await realpath(path.join(checkoutRoot, ".git"));
    return {
      checkoutRoot,
      checkoutId: createHash("sha256").update(commonDir).digest("hex"),
    };
  } catch (error) {
    throw new CommsError("cannot resolve checkout identity", EXIT.DATA, {
      cause: error.message,
    });
  }
}

export async function initBus(context) {
  await ensureBusLayout(context.paths);
  const existing = await readIfPresent(context.paths.protocol, validateProtocol);
  if (existing !== null) return existing;

  const identity = await checkoutIdentity(context.paths);
  const record = validateProtocol({
    schema_version: 1,
    protocol_version: 1,
    checkout_id: identity.checkoutId,
    checkout_root: identity.checkoutRoot,
    initialized_at: context.now().toISOString(),
  });
  try {
    await writeJsonAtomic(context.paths.protocol, record, {
      tmpDir: context.paths.tmp,
      exclusive: true,
    });
    return record;
  } catch (error) {
    if (!(error instanceof CommsError) || error.exitCode !== EXIT.CONFLICT) throw error;
    return readJsonStrict(context.paths.protocol, validateProtocol);
  }
}

export async function registerAgent(context, input) {
  const agentId = inputAgentId(input);
  const existing = await readRegistryIfPresent(context.paths, agentId);
  const presence = await readPresenceIfPresent(context.paths, agentId);
  assertRegistrationAllowed(existing, input, presence, context);
  const git = await context.gitState(input.worktree);
  const record = makeRegistryRecord(input, agentId, git, context.now().toISOString());
  await writeJsonAtomic(context.paths.registryFile(agentId), record, {
    tmpDir: context.paths.tmp,
    exclusive: existing === null,
  });
  return record;
}

export async function requireOpenAgent(context, agentId) {
  const validAgentId = validateAgentId(agentId);
  const registry = await readRegistryIfPresent(context.paths, validAgentId);
  if (registry === null || registry.status !== "open") {
    throw new CommsError("agent is not registered and open", EXIT.CONFLICT, {
      agentId: validAgentId,
    });
  }
  return registry;
}

export async function closeAgent(context, agentId) {
  const validAgentId = validateAgentId(agentId);
  const registry = await readRegistryIfPresent(context.paths, validAgentId);
  if (registry === null) {
    throw new CommsError("agent is not registered", EXIT.DATA, { agentId: validAgentId });
  }
  const presence = await readPresenceIfPresent(context.paths, validAgentId);
  if (presenceIsLive(presence, context)) {
    throw new CommsError("cannot close an agent with a live watcher", EXIT.CONFLICT);
  }
  const timestamp = context.now().toISOString();
  const closed = validateRegistry({
    ...registry,
    status: "closed",
    updated_at: timestamp,
    closed_at: timestamp,
  });
  const offline = validatePresence({
    schema_version: 1,
    agent_id: validAgentId,
    pid: presence?.pid ?? process.pid,
    status: "offline",
    heartbeat_at: timestamp,
  });
  await writeJsonAtomic(context.paths.registryFile(validAgentId), closed, {
    tmpDir: context.paths.tmp,
    exclusive: false,
  });
  await writeJsonAtomic(context.paths.presenceFile(validAgentId), offline, {
    tmpDir: context.paths.tmp,
    exclusive: false,
  });
  await context.releaseOwnedClaims(validAgentId);
  return closed;
}
