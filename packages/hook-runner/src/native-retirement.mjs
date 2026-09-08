// Retire the core fact first. Adapter cleanup is bounded and acts only on the
// endpoint whose retirement was observed; an expired registration is retained
// for on-demand verification, and a successor's endpoint is never touched.
async function attempt(run, deadlineAt) {
  const timeoutMs = Math.max(0, deadlineAt - Date.now());
  if (timeoutMs === 0) return null;
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
  const deadlineAt = Date.now() + Math.max(1, Math.floor(timeoutMs));
  const cleanup = typeof adapter?.retireNativeSession === "function";
  const read = () => service.store.ephemeral.get("deliveryBinding", sessionId);
  const clear = opaqueEndpointRef => opaqueEndpointRef === undefined
    ? service.clearDeliveryBinding({ sessionId, generation, deadlineAt })
    : service.clearDeliveryBinding({ sessionId, generation, opaqueEndpointRef, deadlineAt });
  if (!cleanup) {
    return await attempt(async () => {
      await clear(undefined);
      return true;
    }, deadlineAt) === true;
  }
  // Observation is metadata, not the state transition. A hung read leaves half
  // the shared retirement window for the exact core clear; a cheap read spends
  // only the time it actually takes.
  const observationDeadline = Date.now() + Math.max(1,
    Math.floor(Math.max(0, deadlineAt - Date.now()) / 2));
  const observed = await attempt(async () => ({ binding: await read() }), observationDeadline);
  const prior = observed?.binding;
  const cleared = await attempt(async () => {
    await clear(prior?.opaqueEndpointRef ?? null);
    return true;
  }, deadlineAt) === true;
  if (!cleared || observed === null) return false;
  if (prior?.generation !== generation) return true;
  const after = await attempt(read, deadlineAt);
  if (after?.generation !== generation || after.retiredAt == null
    || after.opaqueEndpointRef !== prior.opaqueEndpointRef) return true;
  await attempt(() => adapter.retireNativeSession({ binding: prior, runtimeDir }), deadlineAt);
  return true;
}
