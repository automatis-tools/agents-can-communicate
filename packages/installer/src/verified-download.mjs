import { createHash } from "node:crypto";

const fail = reasonCode => { throw Object.assign(new Error(reasonCode), { reasonCode }); };

// Only the explicit installer supplies this port. Adapters keep vendor metadata
// and installation behavior, while hook-loaded code has no network implementation.
export async function downloadVerifiedInstaller(source, { fetch = globalThis.fetch } = {}) {
  if (new URL(source.url).protocol !== "https:") fail("prerequisite_download_failed");
  const response = await fetch(source.url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) fail("prerequisite_download_failed");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 131_072) fail("prerequisite_download_failed");
    chunks.push(Buffer.from(chunk));
  }
  const script = Buffer.concat(chunks);
  if (createHash("sha256").update(script).digest("hex") !== source.sha256) {
    fail("prerequisite_integrity_failed");
  }
  return script;
}
