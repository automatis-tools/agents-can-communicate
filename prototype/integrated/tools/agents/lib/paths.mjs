import path from "node:path";

import { CommsError, EXIT } from "./errors.mjs";
import { ensureManagedDirectory } from "./safe-directory.mjs";

const DIRECTORY_NAMES = Object.freeze([
  "registry",
  "presence",
  "inbox",
  "seen",
  "acknowledgements",
  "claims",
  "handoffs",
  "archive",
  "artifacts",
  "locks",
  "quarantine",
  "tmp",
]);

export async function resolveBusDir({ cwd, env = process.env, runGit }) {
  if (env.PW2_AGENT_BUS_DIR !== undefined) {
    if (typeof env.PW2_AGENT_BUS_DIR !== "string"
      || !path.isAbsolute(env.PW2_AGENT_BUS_DIR)) {
      throw new CommsError("PW2_AGENT_BUS_DIR must be absolute", EXIT.DATA,
        { value: env.PW2_AGENT_BUS_DIR });
    }
    return path.resolve(env.PW2_AGENT_BUS_DIR);
  }
  const commonDir = path.resolve(cwd, (await runGit(cwd)).trim());
  if (path.basename(commonDir) !== ".git") {
    throw new CommsError(
      "cannot infer checkout root; set PW2_AGENT_BUS_DIR",
      EXIT.DATA,
    );
  }
  return path.join(path.dirname(commonDir), ".agents");
}

export function createBusPaths(busDir) {
  const root = path.resolve(busDir);
  const directories = Object.fromEntries(
    DIRECTORY_NAMES.map(name => [name, path.join(root, name)]),
  );

  return Object.freeze({
    root,
    protocol: path.join(root, "protocol.json"),
    ...directories,
    registryFile: agentId => path.join(directories.registry, `${agentId}.json`),
    presenceFile: agentId => path.join(directories.presence, `${agentId}.json`),
    inboxDir: agentId => path.join(directories.inbox, agentId),
    inboxFile: (agentId, messageId) => path.join(
      directories.inbox,
      agentId,
      `${messageId}.json`,
    ),
    seenFile: (messageId, recipient) => path.join(
      directories.seen,
      `${messageId}--${recipient}.json`,
    ),
    ackFile: (messageId, recipient) => path.join(
      directories.acknowledgements,
      `${messageId}--${recipient}.json`,
    ),
    handoffFile: handoffId => path.join(directories.handoffs, `${handoffId}.json`),
    archiveDir: agentId => path.join(directories.archive, agentId),
    archiveFile: (agentId, messageId) => path.join(
      directories.archive,
      agentId,
      `${messageId}.json`,
    ),
  });
}

export async function ensureBusLayout(paths) {
  await ensureManagedDirectory(paths.root, paths.root);
  for (const name of DIRECTORY_NAMES) {
    await ensureManagedDirectory(paths.root, paths[name]);
  }
}
