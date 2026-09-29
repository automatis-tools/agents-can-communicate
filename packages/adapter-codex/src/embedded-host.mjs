import path from "node:path";

import { runMaintenanceCommand } from "./maintenance-host.mjs";

// Which process runs a hook tells a daemon-hosted thread from an embedded chat.
// Measured on 0.158.0: a daemon thread's hook runs under
// `codex app-server --listen unix:// --managed-daemon`, while a TUI that found
// no daemon (and did not start one) hosts its own app server and runs the hook
// itself - for the rest of its life, since a later daemon never adopts it.

// Every subcommand `codex --help` lists on 0.158.0 that runs no interactive
// chat. `resume` and `fork` open one, so they are absent.
const NOT_INTERACTIVE = new Set(["exec", "e", "review", "login", "logout", "mcp", "mcp-server",
  "plugin", "app-server", "remote-control", "app", "completion", "update", "doctor", "sandbox",
  "debug", "apply", "a", "queue", "archive", "delete", "migrate-rollouts", "unarchive", "cloud",
  "exec-server", "features", "agents"]);
// Options whose value is the next word, so that word is not a subcommand.
const VALUE_OPTIONS = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s",
  "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "-i", "--image", "--add-dir", "--enable",
  "--disable", "--local-provider"]);

export async function hostArgv(pid) {
  const result = await runMaintenanceCommand("/bin/ps", ["-o", "args=", "-p", String(pid)],
    { timeout: 500 });
  if (result.status !== 0) throw new Error("host process unreadable");
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

// The arguments after Codex itself, or null for any process that is not Codex:
// `codex ...`, or a node script named codex, as `node [options] codex.js ...`.
function codexArguments(argv) {
  const [program, ...rest] = argv;
  if (path.basename(program ?? "") === "codex") return rest;
  if (path.basename(program ?? "") !== "node") return null;
  const script = rest.findIndex(word => !word.startsWith("-"));
  return script >= 0 && path.basename(rest[script]).replace(/\.[mc]?js$/, "") === "codex"
    ? rest.slice(script + 1) : null;
}

/**
 * Whether this command line is an interactive Codex TUI: no subcommand,
 * `resume`, `fork`, or a prompt. `ps` drops quoting, so a prompt whose first
 * word names a subcommand reads as not interactive - the safe direction, which
 * only withholds a notice.
 */
export function interactiveHost(argv) {
  const words = codexArguments(argv);
  if (words === null) return false;
  let value = false;
  for (const word of words) {
    if (value) { value = false; continue; }
    if (word.startsWith("-")) { value = VALUE_OPTIONS.has(word); continue; }
    return !NOT_INTERACTIVE.has(word);
  }
  return true;
}

/** True only when the host was read and is an interactive TUI; never throws. */
export async function runsEmbedded(pid, argvOf = hostArgv) {
  try {
    return interactiveHost(await argvOf(pid));
  } catch {
    return false;
  }
}
