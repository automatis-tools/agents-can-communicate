import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { isWindowsPlatform, readProcessArgs, shellQuote, windowsHookCommand }
  from "@agents-can-communicate/adapter-sdk";

import { listRegistrations, relayDir, removeRegistration } from "./relay-endpoint.mjs";

/**
 * The relays on this machine, across every workspace ACC keeps state for.
 *
 * A relay retires itself when its agy exits; this is for the two moments that
 * cannot wait for that - uninstall, which must leave nothing running, and
 * doctor, which says what is running now. A pid is signalled only while its
 * command line still names the relay binary, because a pid outlives its
 * process and can be reused by anything.
 */
const RELAY_MARK = "acc-antigravity-relay";
const RELAY_LOG = /^antigravity_relay_[a-f0-9]{32}\.log$/;
const defaultAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const psArgv = async pid => await readProcessArgs(pid, { timeoutMs: 1_000 }) ?? [];

// Windows runs no `sh`: there the shim is a Node script, started with node on a
// forward-slash path that PowerShell, cmd and Git Bash read alike.
export const relayShimPath = (home, platform = process.platform) => (isWindowsPlatform(platform)
  ? path.win32.join(home, ".gemini", "config", "acc", "acc-relay.mjs")
  : path.join(home, ".gemini", "config", "acc", "acc-relay.sh"));

/** The command the agent runs once per conversation to start live delivery. */
export const relayStartCommand = (home, platform = process.platform) => (isWindowsPlatform(platform)
  ? windowsHookCommand("portable", { node: "node", shim: relayShimPath(home, platform), args: ["start"] })
  : `sh ${shellQuote(relayShimPath(home, platform))} start`);

async function workspaceDirs(dataHome, list = readdir) {
  if (typeof dataHome !== "string" || dataHome === "") return [];
  const workspaces = path.join(dataHome, "acc", "workspaces");
  try { return (await list(workspaces)).map(name => path.join(workspaces, name)); } catch { return []; }
}

export async function relayRecords({ dataHome, list = readdir }) {
  const found = [];
  for (const runtimeDir of await workspaceDirs(dataHome, list)) {
    for (const record of await listRegistrations({ runtimeDir }).catch(() => [])) {
      found.push({ runtimeDir, record });
    }
  }
  return found;
}

export async function stopRelays({ dataHome, argvOf = psArgv,
  kill = (pid, signal) => process.kill(pid, signal) }) {
  let stopped = 0;
  for (const { runtimeDir, record } of await relayRecords({ dataHome })) {
    try {
      if ((await argvOf(record.relayPid)).some(arg => arg.includes(RELAY_MARK))) {
        kill(record.relayPid, "SIGTERM");
        stopped += 1;
      }
    } catch { /* already gone */ }
    await removeRegistration({ runtimeDir, endpointId: record.endpointId });
  }
  // Logs of relays that already exited have no registration left to find them by.
  for (const runtimeDir of await workspaceDirs(dataHome)) {
    const names = await readdir(relayDir(runtimeDir)).catch(() => []);
    for (const name of names.filter(item => RELAY_LOG.test(item))) {
      await rm(path.join(relayDir(runtimeDir), name), { force: true });
    }
  }
  return stopped;
}

export async function runningRelays({ dataHome, alive = defaultAlive }) {
  return (await relayRecords({ dataHome })).filter(({ record }) => alive(record.relayPid)).length;
}
