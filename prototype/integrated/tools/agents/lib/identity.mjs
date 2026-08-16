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
import { inspectWatcherOwnership, withWatcherLifecycle } from "./watcher-ownership.mjs";

async function readIfPresent(paths, filePath, validate) {
  try {
    return await readJsonStrict(filePath, validate, paths.root);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRegistryIfPresent(paths, agentId) {
  return readIfPresent(paths, paths.registryFile(agentId), validateRegistry);
}

async function readPresenceIfPresent(paths, agentId) {
  return readIfPresent(paths, paths.presenceFile(agentId), validatePresence);
}

function inputAgentId(input) {
  return validateAgentId(input.agentId ?? input.agent_id);
}

function assertRegistrationAllowed(existing, input) {
  if (existing === null) {
    if (input.resume) {
      throw new CommsError("cannot resume an unregistered agent", EXIT.CONFLICT);
    }
    return;
  }
  if (existing.status === "closed") {
    if (input.resume) throw new CommsError("cannot resume a closed agent", EXIT.CONFLICT);
    return;
  }
  if (!input.resume) {
    throw new CommsError("agent id is already open; use --resume or close it", EXIT.CONFLICT);
  }
  if (existing.worktree !== input.worktree || existing.task !== input.task) {
    throw new CommsError("resume requires the registered worktree and task", EXIT.CONFLICT);
  }
}

async function assertNoWatcherOwner(context, agentId, action) {
  const ownership = await inspectWatcherOwnership(context, agentId);
  if (ownership !== null) throw new CommsError(
    `cannot ${action} while watcher ownership exists; stop or explicitly repair it`,
    EXIT.CONFLICT, { agentId, owner: ownership.owner });
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

async function checkoutIdentity(context) {
  try {
    const commonDirInput = context.gitCommonDir === undefined
      ? path.join(path.dirname(context.paths.root), ".git")
      : await context.gitCommonDir();
    const commonDir = await realpath(commonDirInput.trim());
    const checkoutRoot = path.dirname(commonDir);
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
  const identity = await checkoutIdentity(context);
  const existing = await readIfPresent(context.paths, context.paths.protocol, validateProtocol);
  if (existing !== null) {
    assertCheckoutIdentity(existing, identity);
    await ensureBusLayout(context.paths);
    return existing;
  }

  await ensureBusLayout(context.paths);
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
    return assertCheckoutIdentity(await readJsonStrict(context.paths.protocol, validateProtocol,
      context.paths.root), identity);
  }
}

function assertCheckoutIdentity(record, identity) {
  if (record.checkout_id !== identity.checkoutId
    || record.checkout_root !== identity.checkoutRoot) {
    throw new CommsError("protocol belongs to a different checkout", EXIT.DATA, {
      expectedCheckoutId: identity.checkoutId, actualCheckoutId: record.checkout_id,
      expectedCheckoutRoot: identity.checkoutRoot, actualCheckoutRoot: record.checkout_root,
    });
  }
  return record;
}

export async function requireCheckoutProtocol(context, options = {}) {
  let record;
  try {
    record = await readJsonStrict(context.paths.protocol, validateProtocol, context.paths.root);
  } catch (error) {
    if (options.allowInvalid && (error.code === "ENOENT"
      || error instanceof CommsError && error.exitCode === EXIT.DATA)) {
      if (!options.repair) return null;
      const identity = await checkoutIdentity(context);
      const canonicalBus = path.join(identity.checkoutRoot, ".agents");
      if (path.resolve(context.paths.root) === canonicalBus) return null;
      throw new CommsError(
        "cannot prove checkout identity for repair on a noncanonical bus",
        EXIT.DATA,
        { busRoot: context.paths.root, canonicalBus },
      );
    }
    if (error.code === "ENOENT") throw new CommsError(
      "agent bus protocol is not initialized; run init", EXIT.DATA);
    throw error;
  }
  return assertCheckoutIdentity(record, await checkoutIdentity(context));
}

export async function registerAgent(context, input) {
  const agentId = inputAgentId(input);
  return withWatcherLifecycle(context, agentId, async () => {
    const existing = await readRegistryIfPresent(context.paths, agentId);
    assertRegistrationAllowed(existing, input);
    await assertNoWatcherOwner(context, agentId, "register");
    const git = await context.gitState(input.worktree);
    const record = makeRegistryRecord(input, agentId, git, context.now().toISOString());
    await writeJsonAtomic(context.paths.registryFile(agentId), record, {
      tmpDir: context.paths.tmp,
      exclusive: existing === null,
    });
    return record;
  });
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
  return withWatcherLifecycle(context, validAgentId, async () => {
    const registry = await readRegistryIfPresent(context.paths, validAgentId);
    if (registry === null) throw new CommsError(
      "agent is not registered", EXIT.DATA, { agentId: validAgentId });
    await assertNoWatcherOwner(context, validAgentId, "close");
    const presence = await readPresenceIfPresent(context.paths, validAgentId);
    const timestamp = context.now().toISOString();
    const closed = validateRegistry({ ...registry, status: "closed",
      updated_at: timestamp, closed_at: timestamp });
    const offline = validatePresence({ schema_version: 1, agent_id: validAgentId,
      pid: presence?.pid ?? process.pid, status: "offline", heartbeat_at: timestamp });
    await writeJsonAtomic(context.paths.registryFile(validAgentId), closed, {
      tmpDir: context.paths.tmp, exclusive: false });
    await writeJsonAtomic(context.paths.presenceFile(validAgentId), offline, {
      tmpDir: context.paths.tmp, exclusive: false });
    await context.releaseOwnedClaims(validAgentId);
    return closed;
  });
}
