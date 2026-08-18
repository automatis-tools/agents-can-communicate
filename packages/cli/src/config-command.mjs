import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";

import { AccError, CONFIG_FILENAME, EXIT, createId, defaultProjectConfig,
  validateProjectConfig } from "@agents-can-communicate/protocol";

const configPathIn = cwd => path.join(cwd, CONFIG_FILENAME);

/**
 * The file `init` would write, rendered once and used for both the preview and
 * the write. Rendering twice invites a preview that differs from what lands,
 * which is worse than showing nothing.
 */
function renderConfig({ displayName, ids }) {
  return `${JSON.stringify({
    schemaVersion: 1,
    // Generated rather than derived from the path: the whole point of writing
    // this file is an identity that survives the directory being moved,
    // renamed, or cloned somewhere else.
    workspaceId: ids.next("workspace"),
    displayName,
    roots: ["."],
    policy: { claimMode: "advisory", contextBudgetBytes: 6000 },
    requiredAdapters: [],
  }, null, 2)}\n`;
}

async function readConfig(cwd) {
  const file = configPathIn(cwd);
  let handle;
  try {
    // Same rule as discovery: a config reached through a symlink may point
    // anywhere, so it is refused rather than followed.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new AccError(EXIT.DATA, "cannot safely read the workspace config",
      { file, cause: error.message });
  }
  try {
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    throw new AccError(EXIT.DATA, "the workspace config is not valid JSON",
      { file, cause: error.message });
  } finally {
    await handle.close();
  }
}

/**
 * Sessions that would stop seeing each other the moment this file lands.
 *
 * The config carries its own `workspaceId`, so writing one moves the project to
 * a new workspace. Sessions attached to the old one keep heartbeating it and
 * vanish from everyone else's roster - measured: `1 live` before, `0 live`
 * after. They do not recover on their own either: a session re-attaches at
 * SessionStart and at nothing else, so the client has to be restarted.
 *
 * A coordination tool that silently stops coordinating is the worst way for
 * this to be found, so it is refused unless the caller says to go ahead.
 */
async function attachedSessions(probeWorkspace) {
  if (typeof probeWorkspace !== "function") return [];
  try {
    const context = await probeWorkspace();
    const status = await context.service.collectStatus({});
    return status.participants.filter(item => item.presence !== "offline");
  } catch {
    // Nothing to warn about if the workspace cannot be opened at all - and this
    // command must still run on a workspace ACC cannot read, which is half of
    // what it is for.
    return [];
  }
}

async function initConfig({ cwd, interactive, yes, confirm, ids, displayName,
  force = false, probeWorkspace }) {
  const file = configPathIn(cwd);
  if (await readConfig(cwd) !== null) {
    // A committed identity is shared by everyone on the project. Replacing it
    // on a mistyped command would split one workspace into two.
    throw new AccError(EXIT.CONFLICT, `${CONFIG_FILENAME} already exists`, { file });
  }

  const attached = await attachedSessions(probeWorkspace);
  if (attached.length > 0 && !force) {
    const who = attached.map(item => `${item.participantId} (${item.harness})`).join(", ");
    throw new AccError(EXIT.CONFLICT,
      `${attached.length} session(s) are attached here and would stop seeing each `
      + `other: ${who}. They re-attach only when their client starts, so close them `
      + "first, or pass --force to write anyway.",
      { file, sessions: attached.map(item => item.sessionId) });
  }

  const preview = renderConfig({ ids, displayName: displayName ?? path.basename(cwd) });

  if (!yes) {
    if (!interactive) {
      throw new AccError(EXIT.USAGE,
        "refusing to write without confirmation; pass --yes in a non-interactive run",
        { file });
    }
    const approved = await confirm(`write ${file}?\n\n${preview}`);
    if (!approved) return { subcommand: "init", written: false, file, preview };
  }

  // Written with O_EXCL: between the existence check and here, another process
  // may have created the file, and clobbering it would be the same mistake the
  // check exists to prevent.
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    await handle.writeFile(preview, "utf8");
  } finally {
    await handle.close();
  }
  return { subcommand: "init", written: true, file, preview };
}

async function validateConfig({ cwd }) {
  const file = configPathIn(cwd);
  const raw = await readConfig(cwd);
  if (raw === null) {
    // Not an error. Config is optional, and the policy that applies without one
    // is worth reporting rather than leaving the reader to guess.
    return { subcommand: "validate", valid: true, present: false, file,
      config: defaultProjectConfig() };
  }
  return { subcommand: "validate", valid: true, present: true, file,
    config: validateProjectConfig(raw, { source: file }) };
}

/**
 * `acc config init` and `acc config validate`.
 *
 * `init` never writes without agreement: it asks in an interactive run and
 * demands `--yes` otherwise. `validate` only reads - a command a user runs to
 * find out what is wrong must not change the thing it is inspecting.
 */
export async function runConfigCommand({ subcommand, cwd, interactive = true, yes = false,
  confirm, displayName, force = false, probeWorkspace,
  ids = { next: kind => createId(kind) } }) {
  if (subcommand === "init") {
    return initConfig({ cwd, interactive, yes, confirm, ids, displayName,
      force, probeWorkspace });
  }
  if (subcommand === "validate") return validateConfig({ cwd });
  throw new AccError(EXIT.USAGE, `unknown config subcommand: ${subcommand}`, { subcommand });
}
