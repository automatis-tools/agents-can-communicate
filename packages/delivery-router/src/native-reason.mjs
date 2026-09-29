import { listSessionBindings, loadNativeAttempt } from "@agents-can-communicate/adapter-sdk";

/**
 * Why a session has no live transport, as its own last native attempt said.
 *
 * The same record `acc doctor` reads, found through the hook-owner file that
 * names this exact session generation. Null when none says: an attempt that
 * succeeded, a record for another generation, or no runtime to read.
 */
export async function lastNativeReason({ runtimeDir, sessionId, generation }) {
  if (typeof runtimeDir !== "string") return null;
  const owners = (await listSessionBindings({ runtimeDir }))
    .filter(owner => owner.accSessionId === sessionId && owner.generation === generation);
  if (owners.length !== 1) return null;
  const attempt = await loadNativeAttempt({ runtimeDir,
    harnessSessionId: owners[0].harnessSessionId, accSessionId: sessionId, generation });
  return attempt !== null && attempt.state !== "active" ? attempt.reasonCode : null;
}
