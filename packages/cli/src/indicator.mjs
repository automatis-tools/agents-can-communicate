import { createHash } from "node:crypto";
import path from "node:path";
import { assertPortableId } from "@agents-can-communicate/protocol";
import { effectiveCapabilities, loadNativeAttempt, loadSessionBinding, loadOfferObservation }
  from "@agents-can-communicate/adapter-sdk";
import { readDeliveryBindingRecord, readSessionRecord } from "@agents-can-communicate/storage-filesystem";
import { readInstalledLivePolicyState } from "@agents-can-communicate/installer";
import { ALL_ADAPTERS } from "./install-command.mjs";
import { canonicalManagerRoot, managedDirectory, readManagedJson } from "./managed-runtime/state.mjs";
import { platformDataHome, runtimePaths } from "./runtime-paths.mjs";

const receptionText = {
  automatic: "This chat can receive addressed requests without another user prompt. A busy client may queue them.",
  turn: "Messages reach this chat on its next normal turn.",
  inbox: "Messages are available when the agent reads acc inbox; no polling schedule is implied.",
};

function result({ health = "ready", reception = null, reasonCode = null,
  detail, action = null, leaseCurrent = null }) {
  const qualifier = reception && reception !== "automatic" ? ` · ${reception}` : "";
  return { health, reception, reasonCode, leaseCurrent,
    label: `ACC ${health === "ready" ? "●" : "!"}${qualifier}`,
    detail: [detail, receptionText[reception]].filter(Boolean).join(" "), action };
}

export const indicatorFailure = (reasonCode = "state_unreadable") => result({
  health: "problem", reasonCode,
  detail: reasonCode === "not_registered" ? "This chat is not registered with ACC."
    : "ACC could not read this chat's local integration state.",
  action: reasonCode === "not_registered"
    ? "Send a prompt to run the session hooks. If ACC is still absent, run acc doctor and check the plugin is enabled."
    : "Run acc doctor in this project to identify and repair the local state problem.",
});

const actions = {
  client_session_embedded: "This session has no shared delivery service. Run acc doctor to see the launch option and how to open a supported session.",
  client_process_unknown: "Open a new client session so ACC can identify its process; then run acc doctor.",
  transport_permission_denied: "Allow the sending command to access the local delivery channel; acc doctor shows the affected session.",
  handshake_version_mismatch: "Update the client's delivery service to a supported version; acc doctor shows the version in use.",
  native_policy_off: "Automatic delivery is disabled in ACC settings. Run acc install --delivery actionable to enable it.",
  inbound_approval_required: "Approve the pending inbound request in the receiving client, or review its incoming-message setting.",
};

/** A display observation, never CLI ownership. Native ids select one saved room
 * and one binding; there is no roster scan, Git probe, store open, socket probe,
 * lease refresh, heartbeat, update worker or managed-runtime process lease. */
export async function readIndicator({ adapterId, nativeSessionId,
  dataHome = platformDataHome(), now = new Date().toISOString() }) {
  try {
    const adapter = ALL_ADAPTERS().find(item => item.id === adapterId);
    if (!adapter || typeof nativeSessionId !== "string" || !nativeSessionId
      || nativeSessionId.length > 4096) return indicatorFailure("not_registered");
    const key = createHash("sha256").update(JSON.stringify([adapterId, nativeSessionId])).digest("hex");
    const accRoot = await canonicalManagerRoot(path.join(dataHome, "acc"));
    const rooms = path.join(accRoot, "native-workspaces");
    if (!await managedDirectory(rooms)) return indicatorFailure("not_registered");
    const room = await readManagedJson(path.join(rooms, `${key}.json`));
    if (!room) return indicatorFailure("not_registered");
    if (room.schemaVersion !== 1 || room.adapterId !== adapterId
      || room.nativeSessionId !== nativeSessionId) throw new Error("invalid room");
    assertPortableId(room.workspaceId, "workspace id");
    const root = runtimePaths({ dataHome: path.dirname(accRoot), workspaceId: room.workspaceId }).root;
    const owner = await loadSessionBinding({ runtimeDir: root, harnessSessionId: nativeSessionId });
    if (!owner) return indicatorFailure("not_registered");
    const input = { root, workspaceId: room.workspaceId, sessionId: owner.accSessionId };
    const session = await readSessionRecord(input);
    if (session?.state !== "open" || session.generation !== owner.generation
      || session.harness !== adapterId) return indicatorFailure("not_registered");
    const [binding, handshake, policy, offer] = await Promise.all([
      readDeliveryBindingRecord(input),
      loadNativeAttempt({ runtimeDir: root, harnessSessionId: nativeSessionId, ...owner }),
      readInstalledLivePolicyState({ dataHome: path.dirname(accRoot), adapterId }),
      loadOfferObservation({ runtimeDir: root, sessionId: owner.accSessionId, generation: owner.generation }),
    ]);
    const attempt = offer && (!handshake || Date.parse(offer.at) >= Date.parse(handshake.at)) ? offer : handshake;
    const current = await readSessionRecord(input);
    if (current?.state !== "open" || current.generation !== owner.generation) {
      return indicatorFailure("not_registered");
    }
    const capabilities = effectiveCapabilities(adapter, {
      clientName: owner.clientName ?? adapter.client.certificationName,
      clientVersion: owner.clientVersion, platform: owner.platform,
    });
    const fallback = capabilities.delivery.nextTurn ? "turn" : "inbox";
    const bound = binding?.generation === owner.generation && binding.adapterId === adapterId
      && binding.retiredAt == null && binding.availableModes.includes("livePush");
    const leaseCurrent = bound ? Date.parse(binding.leaseUntil) > Date.parse(now) : null;
    if (["missing", "invalid", "unavailable"].includes(policy.policyStatus)) {
      return result({ health: "problem", reception: fallback, reasonCode: "installation_unavailable",
        detail: "ACC cannot find a valid delivery setting for this integration.",
        action: `Run acc install --adapter ${adapterId} to repair the integration.`, leaseCurrent });
    }
    if (policy.policy === "off") return result({ reception: fallback, reasonCode: "native_policy_off",
      detail: "Automatic delivery is disabled in ACC settings.", leaseCurrent });
    if (attempt?.state === "degraded") return result({ health: "problem", reception: fallback,
      reasonCode: attempt.reasonCode ?? "handshake_failed", leaseCurrent,
      detail: "ACC could not establish automatic delivery for this chat.",
      action: actions[attempt.reasonCode]
        ?? "Run acc doctor in this project for the channel failure and the client's recovery steps.",
    });
    // Lease expiry alone is neither disconnection nor an operation in progress.
    // The delivery router verifies the endpoint and renews it on the next send.
    if (bound && binding.livePolicy !== "off") return result({ reception: "automatic", leaseCurrent });
    if (attempt?.state === "unsupported" || !capabilities.delivery.livePush) {
      return result({ reception: fallback, reasonCode: "native_delivery_unsupported",
        detail: "This client session does not support automatic wake-up." });
    }
    return result({ health: "problem", reception: fallback, reasonCode: "native_unbound",
      detail: "This chat has no automatic delivery channel.",
      action: "Send a prompt to let ACC establish the channel; if it remains unavailable, run acc doctor." });
  } catch { return indicatorFailure(); }
}
