import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { LIVE_POLICIES, describeActivation, describeDeactivation, rcFileFor, shimDirFor }
  from "./native-activation.mjs";

/**
 * Turn a detection report into exactly what would happen.
 *
 * Pure and deterministic: same detection, same plan, byte for byte. That is what
 * makes `--dry-run` worth reading - a plan computed differently from the thing
 * it previews is a decoration, and the operator would find out only afterwards.
 */
export function planInstallation({ adapters, detected, context, action = "install",
  recorded = [], accVersion = null, allowDowngrade = false, requested = [],
  deliveryByAdapter = {} }) {
  if (!["install", "uninstall"].includes(action)) {
    throw new AccError(EXIT.USAGE, `unknown installation action: ${action}`, { action });
  }
  const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
  // One explicit answer per selected client. A missing entry is off; a policy
  // for a client that is not part of this run is a mistake to say out loud,
  // not something to store for later.
  if (deliveryByAdapter === null || typeof deliveryByAdapter !== "object") {
    throw new AccError(EXIT.USAGE, "deliveryByAdapter must map adapter ids to policies");
  }
  for (const [adapterId, policy] of Object.entries(deliveryByAdapter)) {
    if (!byId.has(adapterId)) {
      throw new AccError(EXIT.USAGE,
        `delivery policy names ${adapterId}, which is not part of this install`, { adapterId });
    }
    if (!LIVE_POLICIES.includes(policy)) {
      throw new AccError(EXIT.USAGE, `unknown delivery policy: ${policy}`, { adapterId, policy });
    }
  }
  // What ACC recorded writing, by client. For an uninstall this is the
  // authority rather than detection: the record is the only account of what was
  // written, and a client's configuration directory outlives the client.
  const recordedById = new Map(recorded.map(install => [install.adapterId, install]));
  // Presence is decided by running the client's `--version`, which answers "can
  // ACC run this client" - not the question that matters, since ACC never runs
  // it: the client runs ACC's hook. A client installed under a different Node
  // version sat there with its own configuration directory while every install
  // reported it missing. Its existence cannot be inferred from that directory,
  // because ACC creates one itself - an earlier attempt at this read a client's
  // own test fixture as proof the client was there. A person naming the client
  // can be.
  const askedFor = new Set(requested ?? []);
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

    if (!entry.present && record === undefined && !askedFor.has(entry.adapterId)) {
      // Named rather than dropped: "nothing happened" and "that client is not
      // installed on this machine" look the same in an empty list. And the
      // message names the way past itself, because the verdict is on PATH
      // rather than on the machine.
      skipped.push({ adapterId: entry.adapterId,
        reason: `${entry.displayName ?? entry.adapterId} is not installed on this machine; `
          + `if it is, wire it with --adapter ${entry.adapterId}` });
      continue;
    }
    // The version doing the installing is whichever `acc` came first on PATH,
    // and the shim it writes pins that copy's node and runner. So a second ACC
    // on the machine quietly replaces every client's wiring with its own, older
    // code, and the only symptom is a guard behaving like the version it came
    // from. `recordInstall` has always written `accVersion` for exactly this
    // comparison; nothing read it in this direction until now.
    //
    // Never on an uninstall: the older ACC is often the only thing that knows
    // what it wrote, and refusing it would strand the wiring this undoes.
    const wired = recordedById.get(entry.adapterId)?.accVersion;
    if (action === "install" && !allowDowngrade && isOlder(accVersion, wired)) {
      skipped.push({ adapterId: entry.adapterId,
        reason: `${wired} is already wired here and this is ${accVersion}; `
          + "run the newer acc, or pass --downgrade to wire this one deliberately" });
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
    const delivery = deliveryByAdapter[entry.adapterId] ?? "off";
    const native = entry.nativeDelivery ?? null;
    const liveDeliverySupported = native?.state === "eligible"
      && native.activationPlan?.eligible === true;
    const effectiveLivePolicy = liveDeliverySupported ? delivery : "off";
    const deliveryDiagnostic = action === "install" && delivery !== "off"
      && !liveDeliverySupported
      ? entry.deliveryDiagnostic ?? adapter.deliveryFallback?.diagnostic
        ?? `${adapter.displayName ?? adapter.id} cannot receive native delivery `
          + `(${native?.reasonCode ?? "native_delivery_unsupported"}); durable fallback remains active`
      : null;
    const installContext = { ...context, requestedLivePolicy: delivery,
      livePolicy: effectiveLivePolicy };
    // A consented activation that this run keeps, activates, or takes back.
    // Only an explicit off or an uninstall removes one; an absent record never
    // creates one.
    const previous = recordedById.get(entry.adapterId)?.nativeActivation ?? null;
    const nativeActivation = action === "install" && effectiveLivePolicy !== "off"
      ? { livePolicy: effectiveLivePolicy, protocolContract: native.eligibility.protocolContract,
        shell: context?.shell ?? null, rcFile: rcFileFor(context?.home, context?.shell),
        shimDir: typeof context?.stateRoot === "string" ? shimDirFor(context.stateRoot) : null,
        mechanisms: native.activationPlan.mechanisms }
      : null;
    const deactivation = previous !== null
      && (action === "uninstall" || effectiveLivePolicy === "off") ? previous : null;
    const artifacts = (record?.artifacts ?? adapter.planInstall(installContext))
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
      livePolicy: delivery,
      effectiveLivePolicy,
      ...(deliveryDiagnostic === null ? {} : { deliveryDiagnostic }),
      ...(nativeActivation === null ? {} : { nativeActivation }),
      ...(deactivation === null ? {} : { deactivation }),
      artifacts,
      // Said in the operator's terms, not in paths: which files ACC creates
      // outright and which belong to the user and are only edited.
      summary: [
        ...(entry.present ? [] : [`${adapter.displayName ?? adapter.id} is no longer on `
          + "this machine; removing what ACC recorded writing"]),
        ...(deliveryDiagnostic === null ? [] : [deliveryDiagnostic]),
        ...artifacts.filter(a => a.kind === "tree")
          .map(a => `${action === "install" ? "create" : "remove"} ${a.path}`),
        ...artifacts.filter(a => a.kind === "merge")
          .map(a => `${action === "install" ? "add ACC entries to" : "remove ACC entries from"} ${a.path}`),
        ...(nativeActivation === null ? [] : describeActivation(nativeActivation)),
        ...(deactivation === null ? [] : describeDeactivation(deactivation)),
      ],
    });
  }
  return { schemaVersion: 1, action, operations, skipped };
}

/**
 * Is `candidate` an earlier release than `installed`?
 *
 * Numeric per segment, because the first comparison that matters in practice is
 * 0.1.9 against 0.1.10, where a string comparison reverses the answer and starts
 * refusing every legitimate install. Anything unreadable answers false: a
 * corrupt record must not make the machine unrepairable by the command that
 * exists to repair it.
 */
function isOlder(candidate, installed) {
  const parse = value => {
    if (typeof value !== "string") return null;
    const parts = value.trim().split(".");
    if (parts.length !== 3) return null;
    const numbers = parts.map(part => (/^\d+$/.test(part) ? Number(part) : null));
    return numbers.includes(null) ? null : numbers;
  };
  const left = parse(candidate);
  const right = parse(installed);
  if (left === null || right === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}
