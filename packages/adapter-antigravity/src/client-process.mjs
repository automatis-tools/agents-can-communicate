import path from "node:path";

/**
 * Which Antigravity product a hook runs under.
 *
 * Antigravity CLI runs hooks under `agy`, which the adapter's client command
 * already names. Antigravity 2.0 - the desktop app - runs the same
 * `~/.gemini/config/hooks.json` under its language server, with no `agy` at
 * all, on a version line of its own. Captured on 2.19.1, 2026-10-04:
 *
 *   /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone
 *     --override_ide_name antigravity --subclient_type hub --override_ide_version 2.19.1 ...
 *     --https_server_port 0 --csrf_token <uuid> --app_data_dir antigravity ...
 *
 * One language server serves every window and conversation of the app. The
 * IDE's language server has another name, and the CLI keeps its own data in
 * `antigravity-cli`, so `--standalone` with `--app_data_dir antigravity` names
 * the desktop app alone.
 */
export const DESKTOP_CLIENT = Object.freeze({ certificationName: "antigravity-desktop",
  displayName: "Antigravity" });

const STABLE = /^\d+\.\d+\.\d+$/;

/** The value of `--name value` or `--name=value` among the words, or null. */
export function flagValue(words, name) {
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === name) return words[index + 1] ?? null;
    if (words[index].startsWith(`${name}=`)) return words[index].slice(name.length + 1);
  }
  return null;
}

/**
 * The desktop language server's command line, split into its executable and
 * the words after it, or null for any other process. `ps` drops quoting, so the
 * executable is everything before the first option: the bundle path may hold
 * spaces, the options never do.
 */
export function desktopServer(args) {
  if (typeof args !== "string") return null;
  const cut = args.search(/\s--/);
  if (cut === -1) return null;
  const executable = args.slice(0, cut);
  if (path.basename(executable) !== "language_server" || !path.isAbsolute(executable)) return null;
  const words = args.slice(cut).trim().split(/\s+/);
  if (!words.includes("--standalone") || flagValue(words, "--app_data_dir") !== "antigravity") return null;
  const version = flagValue(words, "--override_ide_version");
  return { executable, words, version: STABLE.test(version ?? "") ? version : null };
}

/** The adapter's identifyClientProcess: the desktop app, or null for the runner's own match. */
export function identifyClientProcess(entry) {
  const server = desktopServer(entry?.args);
  if (server === null) return null;
  return { certificationName: DESKTOP_CLIENT.certificationName,
    ...(server.version === null ? {} : { version: server.version }) };
}

/** Whether a process's argv is Antigravity CLI itself: `agy`, by path or bare, `.exe` on Windows. */
export function isAgy(argv) {
  const program = (argv?.[0] ?? "").split(/[\\/]/).at(-1).replace(/\.exe$/i, "").toLowerCase();
  return program === "agy";
}
