import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";
import { withWriterMutex } from "@agents-can-communicate/storage-filesystem";
import { canonicalManagerRoot, managedDirectory, readManagedJson, writeManagedJson }
  from "./managed-runtime/state.mjs";
import { discoverWorkspace } from "./workspace-discovery.mjs";
import { runtimePaths } from "./runtime-paths.mjs";

// Routing only, never session credentials. Unlike a runtime-generation pin,
// this survives client exit: resuming the same native conversation keeps its
// room. Adapter + native id distinguish independent conversations.
export async function resolveHookWorkspace({ adapterId, event, room, cwd, dataHome, env = {},
  gitProbe, clock, deadlineAt }) {
  const identityKey = (adapter, native) => createHash("sha256")
    .update(JSON.stringify([adapter, native])).digest("hex");
  if (room !== undefined && !/^[a-f0-9]{64}$/.test(room)) {
    throw new AccError(EXIT.USAGE, "invalid native room reference");
  }
  const key = room ?? identityKey(adapterId, event.sessionId);
  const directory = path.join(await canonicalManagerRoot(path.join(dataHome, "acc")), "native-workspaces");
  const file = path.join(directory, `${key}.json`);
  const deadline = () => {
    if (Date.now() >= deadlineAt) throw new Error("hook deadline expired before workspace binding");
  };
  const read = async () => {
    if (!await managedDirectory(directory)) return null;
    const record = await readManagedJson(file);
    if (record === undefined) return null;
    if (record?.schemaVersion !== 1 || typeof record.adapterId !== "string"
      || typeof record.nativeSessionId !== "string"
      || identityKey(record.adapterId, record.nativeSessionId) !== key || typeof record.cwd !== "string"
      || !path.isAbsolute(record.cwd) || !["config", "git", "directory"].includes(record.source)
      || record.source === "git" && [record.git?.commonDir, record.git?.worktreeRoot]
        .some(value => typeof value !== "string" || !path.isAbsolute(value))) {
      throw new Error("invalid native workspace binding");
    }
    assertPortableId(record.workspaceId, "bound workspace id");
    return record;
  };
  const discover = async record => {
    let descriptor = await discoverWorkspace({ cwd: record?.cwd ?? event.cwd,
      env: record === null ? env : { ...env, ACC_WORKSPACE_ROOT: record.cwd }, gitProbe });
    if (record?.source === "git" && descriptor.source === "directory") {
      // Git is optional even after startup. Keep both the room and its claim
      // coordinates when a probe fails; do not turn repo/src into a claim root.
      descriptor = { ...descriptor, id: record.workspaceId, source: "git",
        git: { ...record.git, branch: null, head: null, remote: null } };
    }
    if (record?.source === "directory" && descriptor.source === "git") {
      const { git, ...directoryDescriptor } = descriptor;
      descriptor = { ...directoryDescriptor, id: record.workspaceId, source: "directory",
        displayName: path.basename(record.cwd) };
    }
    if (record !== null && descriptor.id !== record.workspaceId) {
      throw new Error("the bound workspace identity changed; refusing to move the native session");
    }
    runtimePaths({ dataHome, workspaceId: descriptor.id, workspaceRoots: descriptor.roots });
    for (const root of descriptor.roots) {
      const relative = path.relative(root, directory);
      if (relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)) {
        throw new AccError(EXIT.USAGE, "workspace contains ACC runtime state through its data-home path",
          { reasonCode: "workspace_contains_runtime", root: directory, workspaceRoot: root, dataHome });
      }
    }
    const workspaceCwd = record?.cwd ?? await realpath(env.ACC_WORKSPACE_ROOT || event.cwd);
    // A checkout can change without changing the room. Preserve repository-
    // relative claims in linked worktrees, but never rebase parent-room claims
    // onto a different nested repository merely because the agent entered it.
    let current = descriptor;
    if (descriptor.source === "git" && path.resolve(event.cwd) !== workspaceCwd) {
      const git = await gitProbe({ cwd: event.cwd }).catch(() => null);
      if (git !== null && await realpath(git.commonDir) === descriptor.git.commonDir) {
        current = { ...descriptor, git };
      }
    }
    deadline();
    return { descriptor: current, workspaceCwd,
      ...(record !== null ? { workspaceRef: `acc://${key}` } : {}) };
  };

  const existing = await read();
  if (room !== undefined) {
    if (existing === null) throw new AccError(EXIT.DATA, "the native room reference no longer exists");
    event = { kind: "observe", sessionId: existing.nativeSessionId, cwd: cwd ?? existing.cwd };
  }
  if (existing !== null) return discover(existing);
  const context = await discover(null);
  if (!["sessionStart", "beforeTurn"].includes(event.kind)) return context;
  // Validate runtime containment before creating anything. Concurrent startup
  // and prompt hooks must agree on the first room before either opens an owner.
  await managedDirectory(directory, { create: true });
  return withWriterMutex({ locks: path.join(directory, "locks", key) },
    { root: directory, clock, deadlineAt }, async () => {
      const raced = await read();
      if (raced !== null) return discover(raced);
      deadline();
      await writeManagedJson(file, { schemaVersion: 1, adapterId,
        nativeSessionId: event.sessionId, cwd: context.workspaceCwd,
        workspaceId: context.descriptor.id, source: context.descriptor.source,
        ...(context.descriptor.source === "git" ? { git: {
          commonDir: await realpath(context.descriptor.git.commonDir),
          worktreeRoot: await realpath(context.descriptor.git.worktreeRoot),
        } } : {}) });
      return { ...context, workspaceRef: `acc://${key}` };
    });
}

// An acc:// reference names one validated record in ACC's own data home.
// Ordinary --workspace configs retain their strict relative-root schema.
// A routing reference selects a room; it never establishes CLI owner identity.
export async function resolveSavedHookWorkspace({ reference, ...options }) {
  if (typeof reference !== "string") return null;
  if (!reference.startsWith("acc://")) return null;
  return resolveHookWorkspace({ ...options, room: reference.slice(6) });
}
