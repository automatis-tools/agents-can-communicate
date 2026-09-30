// Finding and starting a client binary the way the platform does. POSIX joins
// the bare name onto each PATH entry; Windows adds an extension from PATHEXT and
// can start a .cmd or .bat only through cmd.exe.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** An environment's search path. A copy of Windows' process.env keeps the
 * variable's own spelling, usually `Path`, and a copy is case-sensitive. */
export const pathOf = env => Object.entries(env ?? {})
  .find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";

/**
 * The file a bare command runs, found on PATH as the platform finds it.
 * POSIX: the first executable `<dir>/<command>`. Windows: `<dir>/<command><ext>`
 * for each PATHEXT extension in order, a real `.exe` before a `.cmd` shim in
 * the same directory, because Node can run an `.exe` directly.
 */
export async function resolveExecutable(command, { pathEnv = pathOf(process.env),
  pathExt = process.env.PATHEXT ?? DEFAULT_PATHEXT, platform = process.platform,
  exclude = [], exists = defaultExists } = {}) {
  const flavour = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  // Windows paths compare without case; POSIX ones do not.
  const key = directory => (platform === "win32" ? flavour.resolve(directory).toLowerCase()
    : flavour.resolve(directory));
  const excluded = exclude.filter(Boolean).map(key);
  const extensions = platform === "win32" && flavour.extname(command) === ""
    ? orderedExtensions(pathExt) : [""];
  for (const directory of String(pathEnv).split(delimiter).filter(Boolean)) {
    if (excluded.includes(key(directory))) continue;
    for (const extension of extensions) {
      const candidate = flavour.join(directory, `${command}${extension}`);
      if (await exists(candidate, platform)) return candidate;
    }
  }
  return null;
}

function orderedExtensions(pathExt) {
  const listed = String(pathExt).split(";").map(item => item.trim().toLowerCase()).filter(Boolean);
  const runnable = listed.filter(item => [".exe", ".com", ".cmd", ".bat"].includes(item));
  return [...new Set([".exe", ...runnable])];
}

async function defaultExists(file, platform) {
  try {
    await access(file, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

// cmd.exe expands and splits these even inside quotes; a fixed argument that
// carries one is refused rather than escaped.
const CMD_UNSAFE = /["%^&|<>\r\n!]/;

/**
 * Run a resolved executable with fixed arguments. Windows cannot start a `.cmd`
 * or `.bat` without cmd.exe (Node refuses with EINVAL since CVE-2024-27980), so
 * those go through `cmd.exe /d /s /c` with a command line ACC builds itself.
 */
// Not async: the promise execFile returns carries `.child`, and a caller that
// must close the child's stdin needs it.
export function runExecutable(file, args, options = {},
  { platform = process.platform, run = execFileAsync, env = process.env } = {}) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) {
    return run(file, args, { windowsHide: true, ...options });
  }
  for (const word of [file, ...args]) {
    if (CMD_UNSAFE.test(word)) {
      return Promise.reject(Object.assign(new Error("argument unsafe for cmd.exe"), { code: "EINVAL" }));
    }
  }
  const line = [file, ...args].map(word => `"${word}"`).join(" ");
  const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  return run(comspec, ["/d", "/s", "/c", `"${line}"`],
    { windowsHide: true, windowsVerbatimArguments: true, ...options });
}
