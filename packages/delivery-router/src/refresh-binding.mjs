import { validateNativeHandshake } from "@agents-can-communicate/adapter-sdk";

const MAX_REFRESH_LEASE_MS = 120_000;

function sameBinding(current, expected, leaseUntil) {
  return current !== null && current !== undefined
    && (current.retiredAt === null || current.retiredAt === undefined)
    && current.sessionId === expected.sessionId
    && current.generation === expected.generation
    && current.adapterId === expected.adapterId
    && current.clientVersion === expected.clientVersion
    && current.opaqueEndpointRef === expected.opaqueEndpointRef
    && current.leaseUntil === leaseUntil;
}

export async function refreshExpiredBinding({ service, adapter, binding, runtimeDir,
  platform, clock, timeoutMs = 750 }) {
  if (typeof adapter?.refreshNativeSession !== "function") return false;
  const now = Date.parse(clock.now());
  if (!Number.isFinite(now)) return false;
  try {
    const handshake = await adapter.refreshNativeSession({ binding, runtimeDir, timeoutMs });
    const validated = validateNativeHandshake(adapter, {
      clientVersion: binding.clientVersion, platform, handshake,
    });
    if (!validated.ok || validated.opaqueEndpointRef !== binding.opaqueEndpointRef) return false;
    const requestedLease = Date.parse(validated.leaseUntil);
    if (!Number.isFinite(requestedLease) || requestedLease <= now) return false;
    const leaseUntil = new Date(Math.min(requestedLease,
      now + MAX_REFRESH_LEASE_MS)).toISOString();
    await service.refreshDeliveryBinding({ sessionId: binding.sessionId,
      generation: binding.generation, leaseUntil });
    const current = await service.store?.ephemeral?.get("deliveryBinding", binding.sessionId);
    return sameBinding(current, binding, leaseUntil);
  } catch {
    return false;
  }
}
