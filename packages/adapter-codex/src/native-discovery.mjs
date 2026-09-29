import { canonicalCwd, hooksForDirectories, loadedThreadMetadata, openCodexAppServer,
  probeCodexQueue } from "./app-server-client.mjs";
import { CODEX_PLUGIN_ID } from "./install.mjs";
import { maintenanceContext, readMaintenancePid, runMaintenanceCommand, verifyMaintenanceProcess }
  from "./maintenance-host.mjs";
import { readySocketPath } from "./native-endpoint.mjs";

// The hooks that register a chat, show it messages, and close it. A directory
// where any of them would not run cannot host a chat ACC may register.
const REGISTERING_EVENTS = ["sessionStart", "sessionEnd", "userPromptSubmit"];
const RUNS = new Set(["trusted", "managed"]);

const accHooksRun = hooks => REGISTERING_EVENTS.every(eventName => hooks.some(hook =>
  hook?.pluginId === CODEX_PLUGIN_ID && hook.eventName === eventName && hook.enabled === true
  && RUNS.has(hook.trustStatus)));

async function withPeer(open, socketPath, timeoutMs, run) {
  const peer = await open({ socketPath, timeoutMs });
  let timer;
  try {
    return await Promise.race([run(peer), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("discovery timed out"),
        { code: "ETIMEDOUT" })), Math.max(1, timeoutMs));
    })]);
  } finally {
    clearTimeout(timer);
    await Promise.resolve(peer.close?.()).catch(() => null);
  }
}

/**
 * Chats the shared daemon holds that ACC could register before their first
 * turn (#167): loaded, idle, neither a subagent nor ephemeral, in a directory
 * where ACC's own hooks are enabled and trusted, on a daemon whose pid and
 * socket are proven. Each carries the daemon's pid, the process a hook for it
 * would record. Metadata only; no conversation is read. Any doubt is an empty
 * answer, never an error.
 */
export function createCodexDiscovery({ run = runMaintenanceCommand, open = openCodexAppServer,
  contextPaths = maintenanceContext } = {}) {
  async function discoverNativeSessions({ env = process.env, home, timeoutMs = 1_500 } = {}) {
    try {
      const paths = await contextPaths({ env, home });
      const socketPath = await readySocketPath(paths.socketPath);
      if (socketPath === null) return [];
      const daemon = await readMaintenancePid(paths.pidPath);
      await verifyMaintenanceProcess(daemon, paths, run);
      return await withPeer(open, socketPath, timeoutMs, async peer => {
        const probe = await probeCodexQueue(peer);
        if (!probe.supported && probe.reasonCode !== "native_session_unavailable") return [];
        const candidates = [];
        for (const thread of await loadedThreadMetadata(peer)) {
          if (thread.parentThreadId != null || thread.ephemeral === true
            || thread.status?.type !== "idle") continue;
          const cwd = await canonicalCwd(thread.cwd);
          if (cwd !== null) candidates.push({ sessionId: thread.id, cwd });
        }
        if (candidates.length === 0) return [];
        const ready = new Set();
        for (const entry of await hooksForDirectories(peer, [...new Set(candidates.map(item => item.cwd))])) {
          const cwd = await canonicalCwd(entry.cwd);
          if (cwd !== null && accHooksRun(entry.hooks)) ready.add(cwd);
        }
        return candidates.filter(item => ready.has(item.cwd)).map(item => ({ ...item,
          clientPid: daemon.pid, clientVersion: probe.serverVersion }));
      });
    } catch {
      return [];
    }
  }
  return { discoverNativeSessions };
}
