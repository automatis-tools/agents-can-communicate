import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { AccError, EXIT, assertPortableId } from "@agents-can-communicate/protocol";

const CONFIG_SCHEMA_VERSION = 1;
// Project config carries identity and shared policy. Presence, messages,
// claims, receipts, and tokens belong to the runtime directory; a repository is
// the wrong place for them and a config that contains them is refused.
const RUNTIME_KEYS = ["sessions", "participants", "messages", "claims", "receipts",
  "intents", "events", "tokens", "credentials"];

/**
 * @typedef {{ id: string, roots: string[], source: "config" | "git" | "directory",
 *   displayName: string, git?: object }} WorkspaceDescriptor
 */

const stableId = value =>
  `workspace_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

async function readConfigNoFollow(configPath) {
  let handle;
  try {
    handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // ELOOP is what O_NOFOLLOW reports for a symlink. A config reached through
    // a link may point anywhere, so it is refused rather than followed.
    throw new AccError(EXIT.DATA, "cannot safely read the workspace config",
      { configPath, cause: error.message });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new AccError(EXIT.DATA, "the workspace config is not a regular file", { configPath });
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof AccError) throw error;
    throw new AccError(EXIT.DATA, "the workspace config is not valid JSON",
      { configPath, cause: error.message });
  } finally {
    await handle.close();
  }
}

function validateConfig(config, configPath) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new AccError(EXIT.DATA, "the workspace config must be an object", { configPath });
  }
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new AccError(EXIT.DATA, "unknown workspace config schemaVersion",
      { configPath, schemaVersion: config.schemaVersion });
  }
  const runtime = RUNTIME_KEYS.filter(key => Object.hasOwn(config, key));
  if (runtime.length > 0) {
    throw new AccError(EXIT.DATA,
      `the workspace config must not carry runtime state: ${runtime.join(", ")}`,
      { configPath, keys: runtime });
  }
  assertPortableId(config.workspaceId, "workspace id");
  return config;
}

async function canonical(directory, label) {
  try {
    return await realpath(directory);
  } catch (error) {
    throw new AccError(EXIT.USAGE, `cannot resolve the ${label}`,
      { directory, cause: error.message });
  }
}

async function probeGit(gitProbe, cwd) {
  if (typeof gitProbe !== "function") return null;
  try {
    return await gitProbe({ cwd });
  } catch {
    // Git is enrichment, never a requirement. A missing binary, a bare
    // directory, or a probe failure all degrade to a directory workspace.
    return null;
  }
}

/**
 * Resolve the workspace for a working directory. Pure: no argument parsing, no
 * stdout, no process exit, because the MCP server and every native adapter
 * import this module directly.
 */
export async function discoverWorkspace({ cwd, env = {}, gitProbe, explicitConfig }) {
  const override = env.ACC_WORKSPACE_ROOT;
  if (typeof override === "string" && override.length > 0 && !path.isAbsolute(override)) {
    throw new AccError(EXIT.USAGE, "ACC_WORKSPACE_ROOT must be an absolute path",
      { value: override });
  }
  const start = await canonical(
    typeof override === "string" && override.length > 0 ? override : cwd, "workspace root");

  const config = explicitConfig === undefined
    ? null
    : validateConfig(await readConfigNoFollow(explicitConfig), explicitConfig);

  const git = await probeGit(gitProbe, start);
  const enrichment = git === null ? {} : {
    git: Object.freeze({
      commonDir: git.commonDir,
      worktreeRoot: git.worktreeRoot,
      branch: git.branch ?? null,
      head: git.head ?? null,
      remote: git.remote ?? null,
    }),
  };

  if (config !== null) {
    return Object.freeze({
      id: config.workspaceId,
      roots: Object.freeze([start]),
      source: "config",
      displayName: config.displayName ?? path.basename(start),
      ...enrichment,
    });
  }

  if (git !== null) {
    // Every worktree of one repository shares the common directory, so they
    // share one workspace while keeping distinct checkout metadata.
    return Object.freeze({
      id: stableId(await canonical(git.commonDir, "Git common directory")),
      roots: Object.freeze([start]),
      source: "git",
      displayName: path.basename(git.worktreeRoot),
      ...enrichment,
    });
  }

  return Object.freeze({
    id: stableId(start),
    roots: Object.freeze([start]),
    source: "directory",
    displayName: path.basename(start),
  });
}
