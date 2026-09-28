import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ENDPOINTS_DIRECTORY } from "./inbox-endpoint.mjs";

// The inbox directories of Claude Code sessions ACC has bound on this machine,
// read from the adapter's own endpoint records in every workspace under ACC's
// state root (review of #217). The environment-derived directories cover
// sessions started from the installer's environment; a session started with
// its own absolute CLAUDE_CODE_TMPDIR or XDG_RUNTIME_DIR binds elsewhere, and
// the hook that bound it wrote down where.
//
// Synchronous and bounded: install, doctor and the managed refresh compose the
// grant list while building one context, once per command. Nothing here
// throws; a record that cannot be read or cannot be a Claude Code inbox adds
// nothing. A grant widens the Codex sandbox, so a directory is taken only when
// it is named as Claude Code names its inbox directories (2.1.283:
// `cc-socks` or `cc-socks-<uid>`), whatever a file on disk says.

const RECORD = /^claude_inbox_[a-f0-9]{32}\.json$/;
const INBOX_DIRECTORY = /^cc-socks(?:-\d+)?$/;
const MAX_BYTES = 8_192;
const MAX_WORKSPACES = 1_024;
const MAX_RECORDS = 256;

const list = directory => {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
};

function socketPathIn(file, uid) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || (uid !== null && info.uid !== uid) || info.size > MAX_BYTES) return null;
    return JSON.parse(readFileSync(fd, "utf8"))?.socketPath ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

export function observedInboxDirectories({ stateRoot, uid = process.getuid?.() ?? null } = {}) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) return [];
  const workspaces = path.join(stateRoot, "workspaces");
  const found = new Set();
  for (const workspace of list(workspaces).slice(0, MAX_WORKSPACES)) {
    const records = path.join(workspaces, workspace, ENDPOINTS_DIRECTORY);
    for (const name of list(records).filter(item => RECORD.test(item)).slice(0, MAX_RECORDS)) {
      const socketPath = socketPathIn(path.join(records, name), uid);
      if (typeof socketPath !== "string" || !path.isAbsolute(socketPath) || socketPath.includes("\0")) continue;
      const directory = path.dirname(path.normalize(socketPath));
      if (INBOX_DIRECTORY.test(path.basename(directory))) found.add(directory);
    }
  }
  return [...found].sort();
}
