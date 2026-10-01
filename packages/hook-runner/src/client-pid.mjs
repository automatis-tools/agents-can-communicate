import { splitWindowsCommandLine } from "@agents-can-communicate/adapter-sdk";

// Deep enough for a client that wraps its hook in a shell and a launcher, short
// enough that a table which disagrees with itself cannot spin.
const MAX_HOPS = 16;

// A client shipped as a node script runs as `node`, so its comm names the
// interpreter. Gemini CLI is one, measured on 0.60.0. For these, the script the
// interpreter was given names the client.
const SCRIPT_HOSTS = new Set(["node"]);
// What scriptsOf reports for a script inside the client's own package.
const CLIENT_PACKAGE = Symbol("client package");
const SCRIPT_EXTENSION = /\.[mc]?js$/;

// Either separator: `ps` names POSIX paths, Win32_Process names Windows ones,
// and the host running the walk may be either.
const basename = value => value.split(/[\\/]/).at(-1);

/** An image name as the client's command: Windows adds `.exe` in any case. */
function imageName(comm) {
  const name = basename(comm);
  return /\.exe$/i.test(name) ? name.slice(0, -4).toLowerCase() : name;
}

/** The words of a command line: Windows quotes paths with spaces. */
const wordsOf = entry => (/\.exe$/i.test(entry.comm) ? splitWindowsCommandLine(entry.args)
  : entry.args.trim().split(/\s+/));

/** What the script a script host runs could be called, without extensions. */
function scriptsOf(entry, clientPackage) {
  if (!SCRIPT_HOSTS.has(imageName(entry.comm)) || typeof entry.args !== "string") return [];
  if (/\.exe$/i.test(entry.comm)) {
    // Windows: the client is node.exe running its package's entry file, whose
    // own name (`index.js`) says nothing; the package directory does.
    const script = wordsOf(entry).slice(1).find(word => !word.startsWith("-"));
    const inPackage = typeof clientPackage === "string" && typeof script === "string"
      && script.replaceAll("\\", "/").includes(`/node_modules/${clientPackage}/`);
    return inPackage ? [CLIENT_PACKAGE] : [];
  }
  // `args` starts with the interpreter as it was invoked, which is the comm
  // itself on macOS; past it, the first word that is no option is the script -
  // unless an option written without `=` came right before it, since that word
  // may be the option's value (`--require ./preload.cjs`). Which options take
  // one depends on the client's own node, so such a word is kept as a candidate
  // and the search goes on; it ends at the first word no bare option precedes.
  const rest = entry.args.startsWith(`${entry.comm} `) ? entry.args.slice(entry.comm.length)
    : entry.args.replace(/^\S+/, "");
  const candidates = [];
  let afterBareOption = false;
  for (const word of rest.trim().split(/\s+/)) {
    if (word === "") continue;
    if (word.startsWith("-")) { afterBareOption = !word.includes("="); continue; }
    candidates.push(basename(word).replace(SCRIPT_EXTENSION, ""));
    if (!afterBareOption) break;
    afterBareOption = false;
  }
  return candidates;
}

/**
 * The pid of the client this hook is running for, or null when nobody knows.
 *
 * The hook is not the client's child. Measured on macOS, a process spawned by
 * Claude Code has parent `/bin/zsh` and grandparent `claude`, so `process.ppid`
 * names a shell that dies with the hook. Walking until the adapter's own
 * declared binary appears is what makes the answer specific rather than a guess
 * about which ancestors are "real".
 *
 * Null is a first-class answer: it means judge this session by age alone.
 */
export function resolveClientPid({ table, from, command, clientPackage, maxHops = MAX_HOPS }) {
  const seen = new Set();
  let current = from;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const entry = table.get(current);
    if (entry === undefined || seen.has(current)) return null;
    seen.add(current);
    // `ps` reports some entries bare (`claude`) and some with a path
    // (`/bin/zsh`), so the comparison has to be on the basename.
    if (imageName(entry.comm) === command
      || scriptsOf(entry, clientPackage).some(name => name === command || name === CLIENT_PACKAGE)) {
      return current;
    }
    if (entry.ppid === current || entry.ppid <= 1) return null;
    current = entry.ppid;
  }
  return null;
}
