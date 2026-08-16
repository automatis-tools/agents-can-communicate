import { homedir } from "node:os";

import { detectInstallation, verifyOwned } from "@agents-can-communicate/installer";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { ALL_ADAPTERS, clientContext } from "./install-command.mjs";
import { platformPaths } from "./platform-paths.mjs";
import { diagnoseFilesystemStore, repairFilesystemStore }
  from "@agents-can-communicate/storage-filesystem";

/**
 * Doctor composes the store's own report with core health rules. Repair fails
 * closed: anything blocked or corrupt stops the run rather than being repaired
 * on top of state the tool cannot even read.
 */
async function diagnoseAdapters({ options, runtime }) {
  // The same home `acc install --home` writes to, or the real one. Reading a
  // different home than install wrote to reports every adapter as missing.
  const home = options?.home ?? runtime?.env?.HOME ?? homedir();
  const clients = clientContext(home);
  const { data: dataHome } = platformPaths({ platform: runtime?.platform,
    env: runtime?.env ?? {} });
  const adapters = ALL_ADAPTERS();
  const detected = await detectInstallation({ adapters, context: clients });

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
    return { ...entry, owned: { modified: owned.modified, missing: owned.missing,
      intact: owned.intact.length }, remediation };
  }));
}

export async function runDoctor({ options, context, runtime }) {
  const root = context.paths.root;
  const report = options.repair === true
    ? await repairFilesystemStore({ root, clock: context.service.clock })
    : await diagnoseFilesystemStore({ root });
  const status = await context.service.collectStatus({});
  const adapters = await diagnoseAdapters({ options, runtime });

  const data = {
    workspaceId: context.descriptor.id,
    source: context.descriptor.source,
    runtimeRoot: root,
    materialised: status.materialised,
    protection: status.protection,
    store: report,
    // Capabilities are reported from what is actually installed, never assumed.
    adapters,
    remediation: [
      ...(report.healthy ? [] : ["inspect blocked and corrupt paths before repairing"]),
      ...adapters.flatMap(adapter => adapter.remediation),
    ],
  };
  if (!report.healthy) {
    throw new AccError(EXIT.DATA, "store state is ambiguous; repair is blocked", data);
  }
  const installed = adapters.filter(adapter => adapter.installed).length;
  const text = `store healthy; ${status.counts.live} live session(s); `
    + `protection ${status.protection}; ${installed} of ${adapters.length} adapter(s) installed`;
  return { data, text };
}
