import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
// Kept above 300 lines so store, installation and native-session findings feed
// one report before service reads. Splitting the diagnostic assembly risks
// opening an unreadable store before its failure has been reported.
import { homedir } from "node:os";
import path from "node:path";

import { describeDeliveryFallback, detectInstallation, livePolicyOf, loadOwnership, verifyOwned }
  from "@agents-can-communicate/installer";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { describeDeliveryDecision, describeNative, nativeRemediation, nativeState,
  updateNativeRuntime } from "./native-delivery-status.mjs";
export { describeNative } from "./native-delivery-status.mjs";
import { nativeSessionLines, updateNativeSessions } from "./native-session-diagnostics.mjs";
import { ALL_ADAPTERS, clientContext, probeTimeout } from "./install-command.mjs";
import { decisionOf } from "./install-delivery-consent.mjs";
import { describePresence, presenceBreakdown, registerNativeSessions } from "./main.mjs";
import { platformPaths } from "./platform-paths.mjs";
import { noticeUpdate } from "./update-check.mjs";
import { managedUpdateDiagnostic } from "./managed-runtime/diagnostics.mjs";
import { readControl } from "./managed-runtime/state.mjs";
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
/**
 * The package directory of the runner a shim or config names, or null.
 *
 * ACC writes the runner in double quotes in every form: a shell shim
 * (`ACC_RUNNER="..."`), the Node shim Windows gets (a JSON string) and Kimi's
 * config (a TOML string holding a command, whose own quotes are cmd's on
 * Windows and TOML's elsewhere). Each quoted string is read the way a shell
 * reads one: a backslash escapes only a quote, a backslash, $ or a backtick,
 * which is all the shim escapes and all a path needs undone in JSON or TOML,
 * so an unescaped C:\Users\... in a shell script stays that path. A string
 * holding quotes is a command. A Windows path in it is cmd's, which has no
 * escape character, so it is read as it stands and a UNC path keeps its leading
 * \\; other words are read the shell's way, since Kimi's POSIX command escapes a
 * quote in a path; then, when no word names the runner, the string is read
 * whole, since a POSIX path may hold a quote.
 * An apostrophe, as in C:\Users\O'Neil, is part of a path. An unquoted path is
 * read to the whitespace before it.
 */
const RUNNER = /[\\/]agents-can-communicate(?=[\\/]bin[\\/]acc-hook\.mjs)/;
const absoluteRoot = value => {
  const match = RUNNER.exec(value);
  if (match === null) return null;
  const root = value.slice(0, match.index + match[0].length);
  return /^(?:[A-Za-z]:)?[\\/]/.test(root) ? root : null;
};

const quotedStrings = text => [...text.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)]
  .map(([, quoted]) => quoted.replace(/\\(["\\$`])/g, "$1"));

const commandRoot = command => {
  for (const [, word] of command.matchAll(/"([^"]*)"/g)) {
    const root = /^(?:[A-Za-z]:\\|\\\\)/.test(word) ? absoluteRoot(word) : null;
    if (root !== null) return root;
  }
  for (const word of quotedStrings(command)) {
    const root = absoluteRoot(word);
    if (root !== null) return root;
  }
  return absoluteRoot(command);
};

export function runnerRoot(text) {
  for (const value of quotedStrings(String(text))) {
    const root = value.includes("\"") ? commandRoot(value) : absoluteRoot(value);
    if (root !== null) return root;
  }
  const flat = String(text);
  const match = RUNNER.exec(flat);
  if (match === null) return null;
  const start = flat.slice(0, match.index).search(/\S+$/);
  return start < 0 ? null : absoluteRoot(flat.slice(start));
}

export async function wiredVersion(shimPath) {
  if (typeof shimPath !== "string" || shimPath === "") return null;
  const text = await readFile(shimPath, "utf8").catch(() => null);
  if (text === null) return null;
  const root = runnerRoot(text);
  if (root === null) return null;
  const manifest = await readFile(path.join(root, "package.json"), "utf8")
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
    // The shell shim on POSIX, the Node shim on Windows.
    else if (/^acc-(?:hook|cli)\.(?:sh|mjs)$/.test(entry.name) || entry.name.endsWith(".sh")) {
      found.push(target);
    }
  }
  return found;
}

export async function diagnoseAdapters({ options, runtime, detect = detectInstallation }) {
  // The same home `acc install --home` writes to, or the real one. Reading a
  // different home than install wrote to reports every adapter as missing.
  const home = options?.home ?? runtime?.env?.HOME ?? homedir();
  const { data: dataHome } = platformPaths({ platform: runtime?.platform,
    env: runtime?.env ?? {} });
  // The same environment install reads, so detection probes the same client.
  const clients = clientContext(home, path.join(dataHome, "acc"),
    { env: runtime?.env ?? {}, platform: runtime?.platform });
  const adapters = ALL_ADAPTERS();
  const detected = await detect({ adapters, context: clients,
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
    return { ...entry, stale, wired, bundleVersion,
      deliveryDecision: installed === undefined ? null : decisionOf(installed),
      owned: { modified: owned.modified,
      missing: owned.missing, intact: owned.intact.length },
      nativeDelivery: nativeState(entry.nativeDelivery, livePolicyOf(installed), {
        contract: adapters.find(adapter => adapter.id === entry.adapterId)?.nativeDelivery,
        activation: installed?.nativeActivation }), remediation };
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
  // Shaped like the storage report, so a reader of one finds every field of
  // the other: without `trimmedThrough` the summary said "history from
  // undefined" on every first doctor in a new project.
  const report = !started
    ? { healthy: true, blocked: [], corrupt: [], repaired: [], swept: 0, staged: 0, partials: 0,
      retired: 0, trimmedThrough: null }
    : options.repair === true
      ? await repairFilesystemStore({ root, clock })
      : await diagnoseFilesystemStore({ root });
  const adapters = await diagnoseAdapters({ options, runtime });
  const { data: dataHome } = platformPaths({ platform: runtime?.platform,
    env: runtime?.env ?? {} });
  const running = typeof runtime?.version === "function"
    ? await runtime.version().catch(() => null)
    : null;
  const manager = runtime?.managerRoot ? await readControl(runtime.managerRoot) : null;
  const update = manager === null
    ? await noticeUpdate({ dataHome, running, env: runtime?.env ?? {},
      now: Date.parse(clock.now()), get: runtime?.fetch, io: { readFile, writeFile, mkdir } })
    : await managedUpdateDiagnostic(runtime.managerRoot, manager, running);

  // Before the store is read for anything else. `collectStatus` reads every
  // record, so on the store this command exists to describe it threw first and
  // took the diagnosis with it: one truncated file and `acc doctor` answered
  // "invalid JSON record", naming nothing, while `inspect` had already found
  // the file and put it in a list nobody ever saw.
  // A contract-6 store is not ambiguous: its identity read and named its
  // version. Before this, doctor called `protocol.json` unreadable and named no
  // migration, on the one store a user just updated into (2026-10-06).
  if (report.migrationRequired === true) {
    throw new AccError(EXIT.DATA, "this workspace's store uses an older contract; ACC migrates it "
      + "by itself once no older ACC client runs. To migrate it now, stop older ACC clients and run "
      + "acc doctor --migrate-store", { workspaceId: context.descriptor.id, source: context.descriptor.source,
      runtimeRoot: root, reasonCode: "store_migration_required", adapters,
      remediation: ["acc doctor --migrate-store"] });
  }
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
  await registerNativeSessions(runtime, context);
  const status = await service.collectStatus({});
  updateNativeRuntime(adapters, status.deliveryBindings);
  // The runtime state above is read from the binding records alone. The
  // session pass then asks each adapter whether the receiver those records
  // name can still take a push, and downgrades anything that only looked
  // active. It needs the adapter objects to ask, which the diagnostic entries
  // do not carry.
  await updateNativeSessions(adapters, { service, status, root, now: clock.now(),
    registry: ALL_ADAPTERS() });
  for (const adapter of adapters) {
    adapter.remediation.push(...nativeRemediation(adapter));
    adapter.remediation = [...new Set(adapter.remediation)];
  }

  const data = {
    workspaceId: context.descriptor.id,
    source: context.descriptor.source,
    runtimeRoot: root,
    materialised: status.materialised,
    protection: status.protection,
    store: report,
    indexDiagnostics: service.store?.indexDiagnostics?.() ?? [],
    // Capabilities are reported from what is actually installed, never assumed.
    adapters,
    update,
    remediation: [...adapters.flatMap(adapter => adapter.remediation),
      // Said here rather than in its own line of prose, because this list is
      // what a reader acts on and an upgrade is one more thing to run.
      ...(update.newer ? [`acc update  # ${update.latest} is on npm, `
        + `you have ${running}`] : [])],
  };
  const installed = adapters.filter(adapter => adapter.installed).length;
  // The remediation was computed, put in the data, and never printed: the
  // command documented as saying "what to run next" said it only to `--json`.
  // A person running `acc doctor` on a client wired to an older plugin was told
  // the store was healthy and nothing else.
  // Named rather than left to be inferred: staging files are reclaimed a
  // bounded amount at a time, so a store still carrying a large accumulation
  // should say so instead of reading as if nothing were held.
  const held = [
    report.staged > 0 ? `${report.staged} staged` : null,
    report.partials > 0 ? `${report.partials} partial` : null,
    // A retired journal entry has no reader at all, so a count above zero says
    // the automatic pass has not caught up rather than that anything is wrong.
    report.retired > 0 ? `${report.retired} retired journal` : null,
    report.trimmedThrough === null ? null : `history from ${report.trimmedThrough}`,
  ].filter(Boolean);
  const staging = held.length === 0 ? "" : ` (${held.join(", ")})`;
  const text = [`store healthy${staging}; `
    + `${describePresence(status.counts, presenceBreakdown(status.participants, ALL_ADAPTERS()))}; `
    + `protection ${status.protection}; ${installed} of ${adapters.length} adapter(s) installed`,
  ...adapters.filter(adapter => (adapter.present || adapter.installed)
    && adapter.nativeDelivery.reasonCode === "native_delivery_unsupported"
    && typeof adapter.deliveryDiagnostic === "string")
    .map(adapter => `  ${adapter.deliveryDiagnostic}`),
  // One concise native-delivery line per detected client, distinguishing
  // eligibility, the recorded policy, and the live runtime state. It never
  // claims that "active" means a model read anything.
  ...adapters.filter(adapter => adapter.present)
    .map(adapter => `  ${adapter.displayName} live delivery: `
      + `${describeNative(adapter.nativeDelivery, { clientVersion: adapter.version })}; `
      + `${adapter.nativeDelivery.policy === "off" && adapter.deliveryDecision !== null
        ? `decision: ${describeDeliveryDecision(adapter.deliveryDecision)}; ` : ""}`
      + `fallback: ${describeDeliveryFallback(adapter)}`),
  ...nativeSessionLines(adapters),
  ...adapters.filter(adapter => adapter.present && adapter.outgoingDelivery?.state === "configured")
    .map(adapter => `  ${adapter.displayName} ${adapter.outgoingDelivery.diagnostic}`),
  // The client's own inbound control decides whether a wake reaches the model.
  // Only someone who turned live delivery on needs to hear about it.
  ...adapters.filter(adapter => adapter.present && adapter.nativeDelivery.configured
    && typeof adapter.inboundDelivery?.diagnostic === "string")
    .map(adapter => `  ${adapter.displayName} inbound: ${adapter.inboundDelivery.diagnostic}`),
  ...(manager === null ? [] : [`  automatic updates ${manager.auto ? "on" : "off"}; ACC ${manager.active.version}`
    + (manager.pin ? `; pinned to ${manager.pin}` : ""), ...(update.notice ? [`  ${update.notice}`] : [])]),
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
