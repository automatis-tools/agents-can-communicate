import { AccError, EXIT } from "@agents-can-communicate/protocol";

/**
 * Turn a detection report into exactly what would happen.
 *
 * Pure and deterministic: same detection, same plan, byte for byte. That is what
 * makes `--dry-run` worth reading - a plan computed differently from the thing
 * it previews is a decoration, and the operator would find out only afterwards.
 */
export function planInstallation({ adapters, detected, context, action = "install" }) {
  if (!["install", "uninstall"].includes(action)) {
    throw new AccError(EXIT.USAGE, `unknown installation action: ${action}`, { action });
  }
  const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
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
    if (!entry.present) {
      // Named rather than dropped: "nothing happened" and "that client is not
      // installed on this machine" look the same in an empty list.
      skipped.push({ adapterId: entry.adapterId,
        reason: `${entry.displayName ?? entry.adapterId} is not installed on this machine` });
      continue;
    }
    if (typeof adapter.planInstall !== "function") {
      skipped.push({ adapterId: entry.adapterId,
        reason: "this adapter cannot describe what it would write" });
      continue;
    }

    const artifacts = adapter.planInstall(context)
      .map(artifact => ({ path: artifact.path, kind: artifact.kind ?? "file" }))
      .sort((a, b) => a.path.localeCompare(b.path));

    operations.push({
      adapterId: adapter.id,
      displayName: adapter.displayName,
      action,
      clientVersion: entry.version ?? null,
      alreadyInstalled: entry.installed === true,
      artifacts,
      // Said in the operator's terms, not in paths: which files ACC creates
      // outright and which belong to the user and are only edited.
      summary: [
        ...artifacts.filter(a => a.kind === "tree")
          .map(a => `${action === "install" ? "create" : "remove"} ${a.path}`),
        ...artifacts.filter(a => a.kind === "merge")
          .map(a => `${action === "install" ? "add ACC entries to" : "remove ACC entries from"} ${a.path}`),
      ],
    });
  }
  return { schemaVersion: 1, action, operations, skipped };
}
