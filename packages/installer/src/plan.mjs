import { AccError, EXIT } from "@agents-can-communicate/protocol";

/**
 * Turn a detection report into exactly what would happen.
 *
 * Pure and deterministic: same detection, same plan, byte for byte. That is what
 * makes `--dry-run` worth reading - a plan computed differently from the thing
 * it previews is a decoration, and the operator would find out only afterwards.
 */
export function planInstallation({ adapters, detected, context, action = "install",
  recorded = [] }) {
  if (!["install", "uninstall"].includes(action)) {
    throw new AccError(EXIT.USAGE, `unknown installation action: ${action}`, { action });
  }
  const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
  // What ACC recorded writing, by client. For an uninstall this is the
  // authority rather than detection: the record is the only account of what was
  // written, and a client's configuration directory outlives the client.
  const recordedById = new Map(recorded.map(install => [install.adapterId, install]));
  const operations = [];
  const skipped = [];

  // Sorted by id, so two runs on the same machine produce identical JSON and a
  // diff between them means something changed rather than that a registry
  // enumerated in a different order.
  for (const entry of [...detected].sort((a, b) => a.adapterId.localeCompare(b.adapterId))) {
    const adapter = byId.get(entry.adapterId);
    if (adapter === undefined) {
      skipped.push({ adapterId: entry.adapterId, reason: "no adapter for this client" });
      continue;
    }
    // A client that has left the machine is still worth visiting when ACC wrote
    // to it. Skipping it made that install permanently unremovable: `acc
    // uninstall` reported success and exit 0, left ACC's tree in the client's
    // configuration directory and ACC's entries in the user's own settings
    // file, and said the same thing on every run afterwards.
    const record = action === "uninstall" && !entry.present
      ? recordedById.get(entry.adapterId)
      : undefined;

    if (!entry.present && record === undefined) {
      // Named rather than dropped: "nothing happened" and "that client is not
      // installed on this machine" look the same in an empty list.
      skipped.push({ adapterId: entry.adapterId,
        reason: `${entry.displayName ?? entry.adapterId} is not installed on this machine` });
      continue;
    }
    if (record === undefined && typeof adapter.planInstall !== "function") {
      skipped.push({ adapterId: entry.adapterId,
        reason: "this adapter cannot describe what it would write" });
      continue;
    }

    // From the record when the client is gone, because that is what was written
    // and so what will be removed. Asking the adapter instead would describe an
    // install for a machine this one no longer is.
    const artifacts = (record?.artifacts ?? adapter.planInstall(context))
      .map(artifact => ({ path: artifact.path, kind: artifact.kind ?? "file" }))
      .sort((a, b) => a.path.localeCompare(b.path));

    operations.push({
      adapterId: adapter.id,
      displayName: adapter.displayName,
      action,
      clientVersion: entry.version ?? record?.version ?? null,
      // "Remove these files for a client that is not here" is a different thing
      // to approve than an ordinary uninstall, so it is said rather than left
      // to be inferred from a client version that is null.
      clientPresent: entry.present === true,
      alreadyInstalled: entry.installed === true,
      artifacts,
      // Said in the operator's terms, not in paths: which files ACC creates
      // outright and which belong to the user and are only edited.
      summary: [
        ...(entry.present ? [] : [`${adapter.displayName ?? adapter.id} is no longer on `
          + "this machine; removing what ACC recorded writing"]),
        ...artifacts.filter(a => a.kind === "tree")
          .map(a => `${action === "install" ? "create" : "remove"} ${a.path}`),
        ...artifacts.filter(a => a.kind === "merge")
          .map(a => `${action === "install" ? "add ACC entries to" : "remove ACC entries from"} ${a.path}`),
      ],
    });
  }
  return { schemaVersion: 1, action, operations, skipped };
}
