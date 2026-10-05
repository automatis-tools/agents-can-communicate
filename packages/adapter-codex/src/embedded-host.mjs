import { readProcessArgs } from "@agents-can-communicate/adapter-sdk";


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
  const argv = await readProcessArgs(pid, { ps: "/bin/ps", timeoutMs: 500 });
  if (argv === null) throw new Error("host process unreadable");
  return argv;
}

// Either separator, and Windows' `.exe` in any case: `codex`, `/usr/local/bin/codex`,
// `C:\Users\dana\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`.
const programName = word => (word ?? "").split(/[\\/]/).at(-1).replace(/\.exe$/i, "").toLowerCase();

// The arguments after Codex itself, or null for any process that is not Codex:
// `codex ...`, or a node script named codex, as `node [options] codex.js ...`.
function codexArguments(argv) {
  const [program, ...rest] = argv;
  if (programName(program) === "codex") return rest;
  if (programName(program) !== "node") return null;
  const script = rest.findIndex(word => !word.startsWith("-"));
  return script >= 0 && programName(rest[script]).replace(/\.[mc]?js$/, "") === "codex"
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
    // `--` ends the options: what follows is the prompt, however it reads.
    if (word === "--") return null;
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
 * Whether this command line is the Codex app's own app server: `codex
 * app-server` that listens nowhere, run from inside an app bundle. Read on the
 * Codex app in ChatGPT.app 26.928: every window serves its threads over stdio
 * this way, never through the shared daemon (openai/codex#41014), so no other
 * process can reach them.
 */
export function desktopAppServer(argv) {
  const words = codexArguments(argv);
  if (words === null || !/\.app\/Contents\//.test(argv[0] ?? "")) return false;
  if (words.some(word => word === "--listen" || word.startsWith("--listen="))) return false;
  // The app puts its config overrides before the subcommand:
  // `codex -c features.code_mode_host=true app-server ...` (26.928).
  return subcommandOf(words) === "app-server";
}

// The first word that is neither an option nor an option's value.
function subcommandOf(words) {
  let value = false;
  for (const word of words) {
    if (value) { value = false; continue; }
    if (word.startsWith("-")) { value = VALUE_OPTIONS.has(word); continue; }
    return word;
  }
  return null;
}

/**
 * For a host that was read and is an interactive TUI, `{ launchOption }` - the
 * option that keeps it embedded, or null when its command line shows none. For
 * the Codex app's own app server, `{ launchOption: null, desktop: true }`.
 * Null for any other host or an unreadable one; never throws.
 */
export async function embeddedHost(pid, argvOf = hostArgv) {
  try {
    const argv = await argvOf(pid);
    if (interactiveHost(argv)) return { launchOption: embeddingOption(argv) };
    return desktopAppServer(argv) ? { launchOption: null, desktop: true } : null;
  } catch {
    return null;
  }
}
