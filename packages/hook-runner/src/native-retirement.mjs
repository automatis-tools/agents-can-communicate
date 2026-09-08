// Retire the core fact first. Adapter cleanup is bounded and acts only on the
// endpoint whose retirement was observed; an expired registration is retained
// for on-demand verification, and a successor's endpoint is never touched.
async function attempt(run, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function retireNativeBinding({ adapter, service, sessionId, generation,
  runtimeDir, timeoutMs = 200 }) {
  const budget = Math.max(1, Math.floor(timeoutMs / 4));
  const cleanup = typeof adapter?.retireNativeSession === "function";
  const read = () => service.store.ephemeral.get("deliveryBinding", sessionId);
  if (!cleanup) {
    try { await service.clearDeliveryBinding({ sessionId, generation }); return true; }
    catch { return false; }
  }
  const observed = await attempt(async () => ({ binding: await read() }), budget);
  const prior = observed?.binding;
  const cleared = await attempt(async () => {
    await service.clearDeliveryBinding({ sessionId, generation,
      opaqueEndpointRef: prior?.opaqueEndpointRef ?? null });
    return true;
  }, budget);
  if (!cleared || observed === null) return false;
  if (prior?.generation !== generation) return true;
  const after = await attempt(read, budget);
  if (after?.generation !== generation || after.retiredAt == null
    || after.opaqueEndpointRef !== prior.opaqueEndpointRef) return true;
  await attempt(() => adapter.retireNativeSession({ binding: prior, runtimeDir }), budget);
  return true;
}
