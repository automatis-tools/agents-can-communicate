import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { detectInstallation, livePolicyOf, loadOwnership, verifyOwned }
  from "@agents-can-communicate/installer";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { ALL_ADAPTERS, clientContext, probeTimeout } from "./install-command.mjs";
import { describePresence } from "./main.mjs";
import { platformPaths } from "./platform-paths.mjs";
import { noticeUpdate } from "./update-check.mjs";
import { diagnoseFilesystemStore, repairFilesystemStore }
  from "@agents-can-communicate/storage-filesystem";

/**
 * Doctor composes the store's own report with core health rules. Repair fails
 * closed: anything blocked or corrupt stops the run rather than being repaired
 * on top of state the tool cannot even read.
 */
/**
 * The bundle in a client outlives the package that put it there.
 *
 * `npm install -g` replaces this CLI and the hook runtime - the shim runs the
 * runtime out of the npm directory rather than a copy - and does not touch what
 * was written into the client: its `hooks.json`, and the skills the agents read.
 * Measured: after an upgrade the client still had `0.1.0` while `acc --version`
 * said `0.1.1`, and doctor called it healthy.
 *
 * Unknown when the install predates the record carrying it, and then nothing is
 * said: "your plugin might be old" on every run is not a diagnosis.
 */
/**
 * The ACC version a client will actually run, read out of its own shim.
 *
 * `staleInstall` compares the version recorded at install time against the one
 * running now. That holds until the thing that rewrote the wiring is an ACC old
 * enough not to know the field: an 0.1.1 first on PATH for one install rewired
 * four clients to itself and rewrote the record with `accVersion: null`, erasing
 * the evidence along with the wiring. The record is written by whoever writes
 * last; the shim carries the absolute path of the runner the client executes,
 * and an old ACC writes it honestly, pointing at itself.
 *
 * Null for anything unreadable. "Might be old" on every run is not a diagnosis.
 */
export async function wiredVersion(shimPath) {
  if (typeof shimPath !== "string" || shimPath === "") return null;
  const text = await readFile(shimPath, "utf8").catch(() => null);
  if (text === null) return null;
  const runner = /["']?(\/[^"'\s]*\/agents-can-communicate)\/bin\/acc-hook\.mjs["']?/.exec(text);
  if (runner === null) return null;
  const manifest = await readFile(path.join(runner[1], "package.json"), "utf8")
    .catch(() => null);
  if (manifest === null) return null;
  try {
    const version = JSON.parse(manifest).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export function staleInstall({ recorded, running }) {
  if (typeof recorded !== "string" || typeof running !== "string") return null;
  return recorded === running ? null : { recorded, running };
}

const RUNTIME_LABEL = Object.freeze({ active: "active", waiting: "waiting for a live session",
  inactive: "not enabled", degraded: "degraded", unsupported: "unsupported" });

/** One human clause for a native-delivery state, next-action implied, never overclaiming. */
export function describeNative(native) {
  if (native.eligibility === "unsupported") {
    return `unsupported${native.reasonCode ? ` (${native.reasonCode})` : ""}`;
  }
  const enabled = native.configured ? `enabled (${native.policy})` : "eligible, not enabled";
  const runtime = RUNTIME_LABEL[native.runtime] ?? native.runtime;
  const degraded = native.eligibility === "degraded" && native.reasonCode
    ? ` - ${native.reasonCode}` : "";
  return `${native.eligibility} - ${enabled} - ${runtime}${degraded}`;
}

/**
 * The runner version behind whatever ACC wrote for one client.
 *
 * Two shapes, because the four clients differ: a config file ACC merged its hook
 * commands into, and a tree ACC created with a shim inside it. The first
 * readable answer wins, and every read is best-effort - a doctor that throws on
 * a missing file diagnoses nothing.
 */
async function wiredVersionFor(artifacts) {
  for (const artifact of artifacts ?? []) {
    if (artifact.kind === "tree") {
      for (const shim of await findShims(artifact.path, 4)) {
        const version = await wiredVersion(shim);
        if (version !== null) return version;
      }
      continue;
    }
    const version = await wiredVersion(artifact.path);
    if (version !== null) return version;
  }
  return null;
}

/** Shim files under a tree ACC created, to a bounded depth. */
async function findShims(root, depth) {
  if (depth < 0) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await findShims(target, depth - 1));
    else if (entry.name.endsWith(".sh")) found.push(target);
  }
  return found;
}

// One closed native-delivery report per adapter, built only from detection,
// ownership, and later the live binding facts - never inferred from a
// configured shim alone. eligibility is what the client could do; configured is
// whether a policy was recorded; policy is that recorded policy; runtime is
// filled in from current bindings; modes and reasonCode carry the closed
// detail. runtime "active" never means the model read anything.
function nativeState(detected, recordedPolicy) {
  const native = detected ?? { state: "unsupported", reasonCode: "native_delivery_unsupported" };
  const eligibility = native.state === "eligible" ? "eligible"
    : native.state === "degraded" ? "degraded" : "unsupported";
  const policy = recordedPolicy ?? "off";
  const configured = policy !== "off";
  const modes = native.state === "eligible" && Array.isArray(native.probe?.modes)
    ? [...native.probe.modes] : [];
  const runtime = eligibility === "unsupported" ? "unsupported"
    : !configured ? "inactive" : "waiting";
  return { eligibility, configured, policy, runtime, modes, reasonCode: native.reasonCode ?? null };
}

async function diagnoseAdapters({ options, runtime }) {
  // The same home `acc install --home` writes to, or the real one. Reading a
  // different home than install wrote to reports every adapter as missing.
  const home = options?.home ?? runtime?.env?.HOME ?? homedir();
  const { data: dataHome } = platformPaths({ platform: runtime?.platform,
    env: runtime?.env ?? {} });
  const clients = clientContext(home, path.join(dataHome, "acc"));
  const adapters = ALL_ADAPTERS();
  const detected = await detectInstallation({ adapters, context: clients,
    probeTimeoutMs: probeTimeout(runtime?.env) });
  const record = await loadOwnership({ dataHome });
  const running = typeof runtime?.version === "function"
    ? await runtime.version().catch(() => null)
    : null;

  return Promise.all(detected.map(async entry => {
    // Compared against what ACC recorded writing, so a plugin someone has since
    // edited reads as theirs rather than as a healthy ACC install.
    const owned = await verifyOwned({ dataHome, adapterId: entry.adapterId });
    const remediation = [];
    if (entry.present && !entry.installed) {
      remediation.push(`acc install --adapter ${entry.adapterId}`);
    }
    if (owned.modified.length > 0) {
      remediation.push(`acc install --adapter ${entry.adapterId}  # files were edited`);
    }
    if (owned.missing.length > 0) {
      remediation.push(`acc install --adapter ${entry.adapterId}  # files are missing`);
    }
    // An adapter can name something only a person can do - the client's own
    // trust prompt, most of all. It goes where a person reads, not into --json.
    remediation.push(...(entry.needsAction ?? []));
    const installed = record.installs.find(one => one.adapterId === entry.adapterId);
    const bundleVersion = installed?.accVersion ?? null;
    const stale = staleInstall({ recorded: bundleVersion, running });
    if (stale !== null) {
      // Names the skills and manifests, not "the plugin". Updating the npm
      // package replaces the CLI and the hook runtime the client's shim points
      // at, so the runner can already be current - `wired` says whether it is -
      // while the skills and manifests copied into the client stay at whatever
      // acc last ran `acc install`. Calling the whole plugin stale reads as a
      // stale runtime and contradicts a `wired` that says otherwise.
      remediation.push(`acc install --adapter ${entry.adapterId}`
        + `  # skills and manifests here are from ${stale.recorded}, acc is ${stale.running}`
        + ` - reinstall to refresh the bundle`);
    }
    // Read from the wiring rather than from the record. An ACC old enough not to
    // know the record's version field still rewrites that record - blank - while
    // pointing every client at itself, so the record goes quiet exactly when it
    // matters. The shim names the runner the client will execute.
    const wired = await wiredVersionFor(installed?.artifacts);
    if (stale === null && typeof wired === "string" && typeof running === "string"
      && wired !== running) {
      remediation.push(`acc install --adapter ${entry.adapterId}`
        + `  # wired to acc ${wired}, this is ${running}`);
    }
    // `wired` is the version of the runner the client executes; `bundleVersion`
    // is the acc that copied the skills and manifests into it. They diverge after
    // an npm upgrade with no `acc install`, and reporting both is what makes the
    // divergence legible rather than hidden behind a single reassuring number.
    return { ...entry, stale, wired, bundleVersion, owned: { modified: owned.modified,
      missing: owned.missing, intact: owned.intact.length },
      nativeDelivery: nativeState(entry.nativeDelivery, livePolicyOf(installed)), remediation };
  }));
}

export async function runDoctor({ options, context, runtime }) {
  const root = context.paths.root;
  // The clock comes from the context rather than through the service, because
  // the service is what may not open: this command runs before anything reads a
  // record, which is the whole point of it.
  const clock = context.clock ?? context.service?.clock;
  // A store that is not there yet is not an ambiguous one. Opening the workspace
  // used to happen first and created it, so the inspection never saw this case;
  // now that the diagnosis runs first, "no protocol.json" would read as
  // "unreadable protocol.json" and a person's first `acc doctor` in a new
  // project would answer that their store is broken.
  const started = await stat(path.join(root, "protocol.json")).then(() => true, () => false);
  const report = !started
    ? { healthy: true, blocked: [], corrupt: [], repaired: [] }
    : options.repair === true
      ? await repairFilesystemStore({ root, clock })
      : await diagnoseFilesystemStore({ root });
  const adapters = await diagnoseAdapters({ options, runtime });
  const { data: dataHome } = platformPaths({ platform: runtime?.platform,
    env: runtime?.env ?? {} });
  const running = typeof runtime?.version === "function"
    ? await runtime.version().catch(() => null)
    : null;
  const update = await noticeUpdate({ dataHome, running, env: runtime?.env ?? {},
    now: Date.parse(clock.now()), get: runtime?.fetch,
    io: { readFile, writeFile, mkdir } });

  // Before the store is read for anything else. `collectStatus` reads every
  // record, so on the store this command exists to describe it threw first and
  // took the diagnosis with it: one truncated file and `acc doctor` answered
  // "invalid JSON record", naming nothing, while `inspect` had already found
  // the file and put it in a list nobody ever saw.
  if (!report.healthy) {
    const broken = [...report.blocked, ...report.corrupt];
    throw new AccError(EXIT.DATA,
      `store state is ambiguous; repair is blocked. ${broken.length} unreadable:\n  `
      + `${broken.slice(0, 10).join("\n  ")}`
      + (broken.length > 10 ? `\n  and ${broken.length - 10} more` : ""),
      { workspaceId: context.descriptor.id, source: context.descriptor.source,
        runtimeRoot: root, store: report, adapters,
        remediation: ["inspect blocked and corrupt paths before repairing"] });
  }

  // Only now, and only because the report said the records can be read. A
  // context built for this command opens the store on request rather than up
  // front.
  const service = context.service ?? await context.openService();
  const status = await service.collectStatus({});
  // The runtime column is the only part that needs a live read: a current
  // reachable binding for this adapter is "active", an expired one "degraded".
  const bindingsByAdapter = new Map();
  for (const binding of status.deliveryBindings ?? []) {
    const existing = bindingsByAdapter.get(binding.adapterId);
    if (existing === undefined || binding.reachable) bindingsByAdapter.set(binding.adapterId, binding);
  }
  for (const adapter of adapters) {
    const native = adapter.nativeDelivery;
    if (native.eligibility === "unsupported") continue;
    const binding = bindingsByAdapter.get(adapter.adapterId);
    native.runtime = binding === undefined ? (native.configured ? "waiting" : "inactive")
      : binding.reachable ? "active" : "degraded";
    if (binding !== undefined && Array.isArray(binding.availableModes)) {
      native.modes = binding.availableModes.filter(mode => mode !== "nextTurn");
    }
  }

  const data = {
    workspaceId: context.descriptor.id,
    source: context.descriptor.source,
    runtimeRoot: root,
    materialised: status.materialised,
    protection: status.protection,
    store: report,
    // Capabilities are reported from what is actually installed, never assumed.
    adapters,
    update,
    remediation: [...adapters.flatMap(adapter => adapter.remediation),
      // Said here rather than in its own line of prose, because this list is
      // what a reader acts on and an upgrade is one more thing to run.
      ...(update.newer ? [`acc update --apply  # ${update.latest} is on npm, `
        + `you have ${running}`] : [])],
  };
  const installed = adapters.filter(adapter => adapter.installed).length;
  // The remediation was computed, put in the data, and never printed: the
  // command documented as saying "what to run next" said it only to `--json`.
  // A person running `acc doctor` on a client wired to an older plugin was told
  // the store was healthy and nothing else.
  const text = [`store healthy; ${describePresence(status.counts)}; `
    + `protection ${status.protection}; ${installed} of ${adapters.length} adapter(s) installed`,
  ...adapters.filter(adapter => (adapter.present || adapter.installed)
    && typeof adapter.deliveryDiagnostic === "string")
    .map(adapter => `  ${adapter.deliveryDiagnostic}`),
  // One concise native-delivery line per detected client, distinguishing
  // eligibility, the recorded policy, and the live runtime state. It never
  // claims that "active" means a model read anything.
  ...adapters.filter(adapter => adapter.present)
    .map(adapter => `  ${adapter.displayName} native delivery: ${describeNative(adapter.nativeDelivery)}`),
  ...data.remediation.map(line => `  ${line}`),
  // `0 of 4` is a true line that reads as a broken machine, and on an
  // MCP-only one it would read that way on every run forever. The server needs
  // no adapter: measured answering `tools/list` and writing an intent on a
  // machine with no client binaries on PATH at all.
  ...(installed === 0
    ? ["  no client is wired; any MCP client can still take part through acc-mcp"]
    : [])].join("\n");
  return { data, text };
}
