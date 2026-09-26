import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scheduleWorker } from "./schedule.mjs";
import { acquireRuntime } from "./leases.mjs";
import { canonicalManagerRoot, readControl, readManagedJson } from "./state.mjs";
import { commandPrefix } from "./command-prefix.mjs";

export const ENTRY_KINDS = Object.freeze([
  "acc", "acc-hook", "acc-mcp", "acc-antigravity-relay",
]);

// Kinds a 0.7.x install wrote a launcher for. The package still ships their
// entrypoints for 0.7.x updaters and launchers; a current install removes the
// launchers themselves.
export const RETIRED_ENTRY_KINDS = Object.freeze(["acc-bootstrap", "acc-claude-channel"]);

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
  if (kind === "acc-hook" || kind === "acc-antigravity-relay") {
    process.stderr.write("acc: coordination unavailable during runtime update; session may continue\n");
    process.exitCode = 0;
  } else {
    process.stderr.write("acc: runtime unavailable; retry after the update or run acc update to recover\n");
    process.exitCode = 4;
  }
}

const stableVersion = value => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
function newerVersion(left, right) {
  if (!stableVersion(left) || !stableVersion(right)) return false;
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

/** Pending means downloaded and verified. Older packages do not advertise this
 * management-only protocol; never load them speculatively for workspace work.
 */
async function updateImplementation(packageRoot, control) {
  let selected = null;
  for (const candidate of [{ root: packageRoot }, control.pending].filter(candidate => candidate?.root)) {
    try {
      const manifest = await readManagedJson(path.join(candidate.root, "package.json"));
      if (manifest?.name !== "agents-can-communicate" || manifest.accManagedUpdateProtocol !== 2
        || candidate.version !== undefined && manifest.version !== candidate.version
        || !newerVersion(manifest.version, selected?.version ?? control.active.version)) continue;
      selected = { root: candidate.root, version: manifest.version };
    } catch { /* Unreadable alternatives leave the active implementation available. */ }
  }
  return selected?.root ?? null;
}

/** The lease lasts until OS process death, including callbacks after main returns. */
export async function runEntry({ kind, packageRoot, managerRoot, managedRequired = false }) {
  if (!ENTRY_KINDS.includes(kind)) throw new Error("unknown ACC entry point");
  const command = kind === "acc" ? commandPrefix(process.argv.slice(2)).command : null;
  let selected = packageRoot;
  let managed = null;
  let managementOnly = false;
  let root;
  try {
    root = await canonicalManagerRoot(managerRoot ?? managerLocation());
    const control = await readControl(root);
    if (control !== null) {
      selected = control.active.root;
      managed = root;
      const update = kind === "acc" && ["update", "doctor"].includes(command)
        ? await updateImplementation(packageRoot, control) : null;
      if (update !== null) {
        selected = update;
        managementOnly = true;
      } else {
        const lease = await acquireRuntime(root, { pid: process.pid, kind });
        selected = lease.runtime.root;
        const quiet = kind === "acc" && ["update", "install", "uninstall", "help", "version",
          "--help", "-h", "--version", "-v", "-V"].includes(command);
        if (!quiet) await scheduleWorker(root, control);
      }
    } else if (managedRequired) throw new Error("managed runtime is not initialized");
  } catch {
    // Help and update recovery must remain reachable when state cannot admit a
    // workspace command. The CLI parser enforces this restricted path; merely
    // putting --help in a message value cannot bypass runtime admission.
    // `selected` was read before this catch and, on this path, holds no
    // lease or pin of its own - a generation reclaimed in the meantime makes
    // this import fail with ENOENT. Degrade below like any other admission
    // failure instead of crashing with a raw stack.
    if (kind === "acc" && selected) {
      try {
        const runtime = await import(pathToFileURL(path.join(selected, "bin", "entrypoints", "acc.mjs")).href);
        await runtime.main({ managerRoot: root ?? null, packageRoot: selected, managementOnly: true });
        return;
      } catch { /* Fall through to the same graceful unavailability below. */ }
    }
    unavailable(kind);
    return;
  }
  const runtime = await import(pathToFileURL(path.join(selected, "bin", "entrypoints", `${kind}.mjs`)).href);
  await runtime.main({ managerRoot: managed, packageRoot: selected, ...(managementOnly ? { managementOnly } : {}) });
}
