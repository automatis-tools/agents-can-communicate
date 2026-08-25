import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import { detectInstallation, loadOwnership, verifyOwned }
  from "@agents-can-communicate/installer";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { ALL_ADAPTERS, clientContext } from "./install-command.mjs";
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
export function staleInstall({ recorded, running }) {
  if (typeof recorded !== "string" || typeof running !== "string") return null;
  return recorded === running ? null : { recorded, running };
}

async function diagnoseAdapters({ options, runtime }) {
  // The same home `acc install --home` writes to, or the real one. Reading a
  // different home than install wrote to reports every adapter as missing.
  const home = options?.home ?? runtime?.env?.HOME ?? homedir();
  const clients = clientContext(home);
  const { data: dataHome } = platformPaths({ platform: runtime?.platform,
    env: runtime?.env ?? {} });
  const adapters = ALL_ADAPTERS();
  const detected = await detectInstallation({ adapters, context: clients });
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
    const stale = staleInstall({
      recorded: record.installs.find(install => install.adapterId === entry.adapterId)
        ?.accVersion ?? null,
      running });
    if (stale !== null) {
      remediation.push(`acc install --adapter ${entry.adapterId}`
        + `  # plugin is ${stale.recorded}, acc is ${stale.running}`);
    }
    return { ...entry, stale, owned: { modified: owned.modified, missing: owned.missing,
      intact: owned.intact.length }, remediation };
  }));
}

export async function runDoctor({ options, context, runtime }) {
  const root = context.paths.root;
  const report = options.repair === true
    ? await repairFilesystemStore({ root, clock: context.service.clock })
    : await diagnoseFilesystemStore({ root });
  const adapters = await diagnoseAdapters({ options, runtime });
  const { data: dataHome } = platformPaths({ platform: runtime?.platform,
    env: runtime?.env ?? {} });
  const running = typeof runtime?.version === "function"
    ? await runtime.version().catch(() => null)
    : null;
  const update = await noticeUpdate({ dataHome, running, env: runtime?.env ?? {},
    now: Date.parse(context.service.clock.now()), get: runtime?.fetch,
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

  const status = await context.service.collectStatus({});

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
  const text = [`store healthy; ${status.counts.live} live session(s); `
    + `protection ${status.protection}; ${installed} of ${adapters.length} adapter(s) installed`,
  ...data.remediation.map(line => `  ${line}`)].join("\n");
  return { data, text };
}
