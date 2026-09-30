import path from "node:path";

// Where Claude Code binds a session's inbox socket, read from the 2.1.283
// binary (2026-09-27):
//
//   `${XDG_RUNTIME_DIR || CLAUDE_CODE_TMPDIR || "/tmp"}/cc-socks/<pid>.sock`
//
// and, when that path is longer than 103 bytes, `/tmp/cc-socks-<uid>/<pid>.sock`
// (`$PREFIX/tmp` when TERMUX_VERSION is set). Claude Code's own list of default
// socket directories adds `/run/user/<uid>/cc-socks` on Linux. Observed on
// macOS: `/tmp/cc-socks/<pid>.sock`.
//
// A sender in a sandbox - a Codex shell running `acc reply` - has to be allowed
// to connect here, or every live offer to a Claude Code session fails with
// EPERM and waits for the recipient's next turn. The grant is a directory; the
// adapter still checks Claude Code's session registry before every write, so a
// wider grant cannot wake a reused pid.
//
// A relative override is resolved against the Claude Code process's own working
// directory, which no installer can know, so it is left out. Native Windows
// serves the inbox on a named pipe, which no Unix socket grant covers.

const hostOf = platform => String(platform ?? process.platform).split("-")[0];
// Every branch below is a POSIX client's layout, built the same on any host.
const posix = path.posix;
const set = value => typeof value === "string" && value !== "";

export function inboxSocketDirectories({ env = {}, platform, uid } = {}) {
  const host = hostOf(platform);
  if (host === "win32") return [];
  const user = Number.isInteger(uid) ? uid : (process.getuid?.() ?? 0);
  // Claude Code's `||`: an empty value falls through to the next one.
  const root = [env.XDG_RUNTIME_DIR, env.CLAUDE_CODE_TMPDIR].find(set) ?? "/tmp";
  const fallbackRoot = set(env.TERMUX_VERSION) && set(env.PREFIX)
    ? posix.join(env.PREFIX, "tmp") : "/tmp";
  const directories = [
    posix.join(root, "cc-socks"),
    "/tmp/cc-socks",
    ...(host === "linux" ? [`/run/user/${user}/cc-socks`] : []),
    posix.join(fallbackRoot, `cc-socks-${user}`),
  ];
  return [...new Set(directories.filter(directory => posix.isAbsolute(directory)))];
}
