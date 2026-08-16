import { AccError, EXIT } from "@agents-can-communicate/protocol";
import { diagnoseFilesystemStore, repairFilesystemStore }
  from "@agents-can-communicate/storage-filesystem";

/**
 * Doctor composes the store's own report with core health rules. Repair fails
 * closed: anything blocked or corrupt stops the run rather than being repaired
 * on top of state the tool cannot even read.
 */
export async function runDoctor({ options, context }) {
  const root = context.paths.root;
  const report = options.repair === true
    ? await repairFilesystemStore({ root, clock: context.service.clock })
    : await diagnoseFilesystemStore({ root });
  const status = await context.service.collectStatus({});

  const data = {
    workspaceId: context.descriptor.id,
    source: context.descriptor.source,
    runtimeRoot: root,
    materialised: status.materialised,
    protection: status.protection,
    store: report,
    // Capabilities are reported from what is actually installed, never assumed.
    adapters: [],
    remediation: report.healthy ? [] : ["inspect blocked and corrupt paths before repairing"],
  };
  if (!report.healthy) {
    throw new AccError(EXIT.DATA, "store state is ambiguous; repair is blocked", data);
  }
  const text = `store healthy; ${status.counts.live} live session(s); `
    + `protection ${status.protection}`;
  return { data, text };
}
