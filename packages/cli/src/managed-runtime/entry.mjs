import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scheduleWorker } from "./schedule.mjs";
import { acquireRuntime } from "./leases.mjs";
import { canonicalManagerRoot, readControl } from "./state.mjs";

export const ENTRY_KINDS = Object.freeze([
  "acc", "acc-hook", "acc-mcp", "acc-bootstrap", "acc-claude-channel",
]);

// Bootstrap resolution deliberately needs only Node built-ins: no selected
// generation is imported until admission and its actual PID lease are durable.
export function managerLocation({ env = process.env, platform = process.platform } = {}) {
  const data = env.ACC_DATA_HOME || (platform === "win32" ? env.APPDATA
    : platform === "darwin" ? env.HOME && path.join(env.HOME, "Library", "Application Support")
      : env.XDG_DATA_HOME || env.HOME && path.join(env.HOME, ".local", "share"));
  if (typeof data !== "string" || !path.isAbsolute(data)) throw new Error("cannot resolve ACC data home");
  return path.join(data, "acc", "runtime");
}

export function invokedDirectly(url) {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); }
  catch { return false; }
}

function unavailable(kind) {
  // Never reflect control file content or payloads into a client diagnostic.
  if (kind === "acc-hook" || kind === "acc-claude-channel") {
    process.stderr.write("acc: coordination unavailable during runtime update; session may continue\n");
    process.exitCode = 0;
  } else if (kind === "acc-bootstrap") {
    process.exitCode = 1; // The vendor shell shim launches its original command.
  } else {
    process.stderr.write("acc: runtime unavailable; retry after the update or run acc update to recover\n");
    process.exitCode = 4;
  }
}

/** The lease lasts until OS process death, including callbacks after main returns. */
export async function runEntry({ kind, packageRoot, managerRoot, managedRequired = false }) {
  if (!ENTRY_KINDS.includes(kind)) throw new Error("unknown ACC entry point");
  let selected = packageRoot;
  let managed = null;
  let root;
  try {
    root = await canonicalManagerRoot(managerRoot ?? managerLocation());
    const control = await readControl(root);
    if (control !== null) {
      selected = control.active.root;
      managed = root;
      const lease = await acquireRuntime(root, { pid: process.pid, kind });
      selected = lease.runtime.root;
      managed = root;
      const quiet = kind === "acc" && ["update", "install", "uninstall", "help", "version",
        "--help", "-h", "--version", "-v", "-V"].includes(process.argv[2]);
      if (!quiet) await scheduleWorker(root, control);
    } else if (managedRequired) throw new Error("managed runtime is not initialized");
  } catch {
    // Help and update recovery must remain reachable when state cannot admit a
    // workspace command. The CLI parser enforces this restricted path; merely
    // putting --help in a message value cannot bypass runtime admission.
    if (kind === "acc" && selected) {
      const runtime = await import(pathToFileURL(path.join(selected, "bin", "entrypoints", "acc.mjs")).href);
      await runtime.main({ managerRoot: root ?? null, packageRoot: selected, managementOnly: true });
      return;
    }
    unavailable(kind);
    if (kind === "acc-claude-channel" && selected) {
      const { startInertChannel } = await import(pathToFileURL(path.join(selected,
        "bin", "entrypoints", "claude-channel-stdio.mjs")).href);
      startInertChannel();
    }
    return;
  }
  const runtime = await import(pathToFileURL(path.join(selected, "bin", "entrypoints", `${kind}.mjs`)).href);
  await runtime.main({ managerRoot: managed, packageRoot: selected });
}
