import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const failedCleanup = Object.freeze({ attempted: true, outcome: "failed",
  ownedProcesses: "failed", temporaryState: "failed" });

export async function finalizeHarnessRun({ h, setupFailure, output, startedAt, failed, failure, validate }) {
  let cleanup = setupFailure?.cleanup;
  if (h) {
    cleanup = await h.cleanup().catch(() => ({ ...failedCleanup }));
    for (const record of h.scenarios) record.cleanup = cleanup;
  }
  cleanup ??= { attempted: true, outcome: "passed",
    ownedProcesses: "stopped", temporaryState: "removed" };
  const source = h ?? setupFailure ?? {};
  const result = { schemaVersion: 1, source: "real-client-capture", client: "codex-cli",
    phase: source.phase ?? null, clientVersion: source.version ?? null,
    platform: `${process.platform}-${process.arch}`, packageSha256: source.packageSha256 ?? null,
    startedAt, finishedAt: new Date().toISOString(), scenarioCount: source.scenarios?.length ?? 0,
    passedCount: source.scenarios?.filter(item => item.outcome === "passed").length ?? 0,
    failedCount: source.scenarios?.filter(item => item.outcome !== "passed").length ?? 0,
    cleanup, scenarios: source.scenarios ?? [] };
  let finalFailure = failure ?? null;
  if (!failed && cleanup.outcome === "passed") {
    try { validate(result); }
    catch (error) { finalFailure = { stage: "evidence-validation", error: error.message }; }
  }
  await mkdir(output, { recursive: true });
  if (finalFailure === null && !failed && cleanup.outcome === "passed") {
    await writeFile(path.join(output, "evidence.json"), `${JSON.stringify(result, null, 2)}\n`);
    return { complete: true, ...result };
  }
  const incomplete = { complete: false, ...result,
    failure: finalFailure ?? { stage: "cleanup", error: "owned cleanup failed" } };
  await writeFile(path.join(output, "incomplete-evidence.json"), `${JSON.stringify(incomplete, null, 2)}\n`);
  return incomplete;
}
