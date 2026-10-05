import { execFile } from "node:child_process";
import { readFile as readText } from "node:fs/promises";
import path from "node:path";

import { resolveExecutable, runExecutable } from "@agents-can-communicate/adapter-sdk";

const VERSION = /(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\b|$)/;

export function parseClientVersion(output) {
  return typeof output === "string" ? VERSION.exec(output)?.[1] ?? null : null;
}

/** Probe the client binary once when its real session starts. */
export function probeClientVersion(adapter, { timeoutMs = 1_000 } = {}) {
  if (process.platform === "win32") return probeOnWindows(adapter, timeoutMs);
  return new Promise(resolve => {
    execFile(adapter.client.command, adapter.client.versionArgs ?? ["--version"], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null) return resolve(null);
      resolve(parseClientVersion(`${stdout}${stderr}`));
    });
  });
}

/**
 * The executable a client process runs, when `ps` names it by absolute path and
 * that path is the client's command: a desktop app starts its own build by full
 * path (Claude.app's claude, ChatGPT.app's codex), and asking that file is
 * asking the session's own build. Null otherwise, and always on Windows, whose
 * process names carry no path.
 */
export function ownExecutable(entry, command) {
  if (process.platform === "win32" || typeof entry?.comm !== "string") return null;
  return path.isAbsolute(entry.comm) && path.basename(entry.comm) === command ? entry.comm : null;
}

/** That executable's `--version`, parsed like the PATH probe's; null on any failure. */
export function probeExecutableVersion(file, versionArgs = ["--version"], { timeoutMs = 1_000 } = {}) {
  return new Promise(resolve => {
    execFile(file, versionArgs, { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true },
      (error, stdout, stderr) => resolve(error === null ? parseClientVersion(`${stdout}${stderr}`) : null));
  });
}

// A package script the npm .cmd shim runs: `"%dp0%\<path inside the prefix>"`.
const SHIM_TARGET = /"%dp0%\\([^"%]+\.(?:c|m)?js)"/gi;
const DEPTH = 6;

/**
 * The version of the package an npm .cmd shim runs, or null when the file is no
 * such shim. npm writes a .cmd per bin that runs node on the package's script;
 * the package whose `bin` names that script is the client, and its version is
 * what the client's --version prints - without starting cmd.exe, node and, for
 * Codex, the native binary behind it.
 */
export async function npmShimVersion(file, { readFile = readText } = {}) {
  try {
    const targets = [...String(await readFile(file, "utf8")).matchAll(SHIM_TARGET)];
    if (targets.length !== 1) return null;
    const script = path.win32.join(path.win32.dirname(file), targets[0][1]);
    let directory = path.win32.dirname(script);
    for (let depth = 0; depth < DEPTH; depth += 1) {
      const manifest = await readFile(path.win32.join(directory, "package.json"), "utf8")
        .then(JSON.parse, error => (error.code === "ENOENT" ? null : Promise.reject(error)));
      if (manifest !== null) {
        const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
        const runs = bins.some(bin => typeof bin === "string"
          && path.win32.resolve(directory, bin).toLowerCase() === path.win32.resolve(script).toLowerCase());
        return runs ? parseClientVersion(String(manifest.version)) : null;
      }
      const parent = path.win32.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    return null;
  } catch {
    return null;
  }
}

// Windows finds `codex.cmd` or `claude.exe`, never the bare name, and starts a
// .cmd only through cmd.exe.
async function probeOnWindows(adapter, timeoutMs) {
  const started = Date.now();
  try {
    const file = await resolveExecutable(adapter.client.command);
    if (file === null) return null;
    if (/\.cmd$/i.test(file)) {
      const packaged = await npmShimVersion(file);
      if (packaged !== null) return packaged;
    }
    const { stdout, stderr } = await runExecutable(file, adapter.client.versionArgs ?? ["--version"],
      { timeout: Math.max(1, timeoutMs - (Date.now() - started)), killSignal: "SIGKILL" });
    return parseClientVersion(`${stdout}${stderr}`);
  } catch {
    return null;
  }
}
