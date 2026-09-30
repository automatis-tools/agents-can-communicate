import { execFile } from "node:child_process";

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

// Windows finds `codex.cmd` or `claude.exe`, never the bare name, and starts a
// .cmd only through cmd.exe.
async function probeOnWindows(adapter, timeoutMs) {
  const started = Date.now();
  try {
    const file = await resolveExecutable(adapter.client.command);
    if (file === null) return null;
    const { stdout, stderr } = await runExecutable(file, adapter.client.versionArgs ?? ["--version"],
      { timeout: Math.max(1, timeoutMs - (Date.now() - started)), killSignal: "SIGKILL" });
    return parseClientVersion(`${stdout}${stderr}`);
  } catch {
    return null;
  }
}
