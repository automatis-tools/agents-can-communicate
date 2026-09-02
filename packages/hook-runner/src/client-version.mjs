import { execFile } from "node:child_process";

const VERSION = /(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\b|$)/;

export function parseClientVersion(output) {
  return typeof output === "string" ? VERSION.exec(output)?.[1] ?? null : null;
}

/** Probe the client binary once when its real session starts. */
export function probeClientVersion(adapter, { timeoutMs = 1_000 } = {}) {
  return new Promise(resolve => {
    execFile(adapter.client.command, adapter.client.versionArgs ?? ["--version"], {
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null) return resolve(null);
      resolve(parseClientVersion(`${stdout}${stderr}`));
    });
  });
}
