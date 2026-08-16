import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { AccError, CONFIG_FILENAME, EXIT, validateProjectConfig }
  from "@agents-can-communicate/protocol";

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

/**
 * Walk up looking for the one config filename.
 *
 * Sessions start wherever the human happens to be, so a config that only counted
 * at the top of the tree would apply to some sessions in a project and not
 * others. The walk stops at the filesystem root: climbing past it would let a
 * stray file in a home directory claim every project underneath.
 */
async function findConfig(start) {
  let directory = start;
  for (;;) {
    const candidate = path.join(directory, CONFIG_FILENAME);
    const config = await readConfigNoFollow(candidate);
    if (config !== null) return { config, configPath: candidate, base: directory };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
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

  const found = explicitConfig === undefined
    ? await findConfig(start)
    : { config: await readConfigNoFollow(explicitConfig), configPath: explicitConfig,
      base: path.dirname(explicitConfig) };
  const config = found?.config == null
    ? null
    : validateProjectConfig(found.config, { source: found.configPath });

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
    // Declared roots are relative to the config, never to the working
    // directory. Runtime containment is checked against these, so resolving
    // them against the wrong base would let state land somewhere it must not.
    const roots = await Promise.all(config.roots
      .map(root => canonical(path.resolve(found.base, root), "declared workspace root")));
    return Object.freeze({
      id: config.workspaceId,
      roots: Object.freeze([...new Set(roots)]),
      source: "config",
      displayName: config.displayName ?? path.basename(found.base),
      policy: config.policy,
      requiredAdapters: config.requiredAdapters,
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
