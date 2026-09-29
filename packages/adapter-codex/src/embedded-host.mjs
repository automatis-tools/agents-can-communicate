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

// Options that make Codex run a chat on its own embedded app server even while
// the daemon runs. Measured on 0.159.1, which says so only behind its status
// line: "Running without the shared background server: command-line
// configuration overrides (-c, --enable, --disable, or --search) requires
// embedded mode." The same sentence names --profile, --oss, --strict-config,
// --dangerously-bypass-hook-trust and --no-daemon.
const EMBEDDING_OPTIONS = new Set(["-c", "--config", "--enable", "--disable", "--search", "-p",
  "--profile", "--oss", "--strict-config", "--dangerously-bypass-hook-trust", "--no-daemon"]);
const OPENS_CHAT = new Set(["resume", "fork"]);

// `--config=x` and `-cx` carry their value; both name the option they spell.
const optionName = word => word.startsWith("--") ? word.split("=", 1)[0] : word.slice(0, 2);

/**
 * The first option on this interactive command line that keeps the chat
 * embedded, as typed, or null. Scanning stops at the prompt: `ps` drops quotes,
 * so a later word may be the prompt's own text.
 */
export function embeddingOption(argv) {
  const words = codexArguments(argv);
  if (words === null) return null;
  let value = false;
  let opened = false;
  for (const word of words) {
    if (value) { value = false; continue; }
    if (word.startsWith("-")) {
      if (EMBEDDING_OPTIONS.has(optionName(word))) return optionName(word);
      value = VALUE_OPTIONS.has(word);
      continue;
    }
    if (opened || !OPENS_CHAT.has(word)) return null;
    opened = true;
  }
  return null;
}

/**
 * For a host that was read and is an interactive TUI, `{ launchOption }` - the
 * option that keeps it embedded, or null when its command line shows none.
 * Null for any other host or an unreadable one; never throws.
 */
export async function embeddedHost(pid, argvOf = hostArgv) {
  try {
    const argv = await argvOf(pid);
    return interactiveHost(argv) ? { launchOption: embeddingOption(argv) } : null;
  } catch {
    return null;
  }
}
