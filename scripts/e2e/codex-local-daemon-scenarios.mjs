import { productSetup, productIsolation, productIdle, productReply, productLongIdle }
  from "./codex-local-daemon-product-base.mjs";
import { productBusy, productNextTurn } from "./codex-local-daemon-product-busy.mjs";
import { productPolicy, productPolicyOff, productUninstall } from "./codex-local-daemon-product-policy.mjs";
import { productSenderHome, productFaults } from "./codex-local-daemon-product-faults.mjs";
import { productEmbedded, productDaemonRecovery } from "./codex-local-daemon-product-recovery.mjs";
import { productRemoteNegative, productExplicitModes, productSessionChanges } from "./codex-local-daemon-product-modes.mjs";
import { productPaths } from "./codex-local-daemon-product-paths.mjs";
import { runLegacyMigration } from "./codex-local-daemon-migration.mjs";
import { scenario } from "./codex-local-daemon-observations.mjs";
import path from "node:path";

async function productMigration(h) {
  if (!h.legacyTarball) throw new Error("P18 requires --legacy-tarball from the genuine legacy commit");
  const s = scenario(h, "P18");
  const result = await runLegacyMigration({ legacyTarball: h.legacyTarball, candidateTarball: h.tarball,
    codex: h.codex, output: path.join(h.output, "legacy-migration.md") });
  s.record.assertionCount += result.assertionCount;
  s.equal(result.candidatePackageSha256, h.packageSha256);
  s.equal(result.cleanup.outcome, "passed");
  s.fact("artifact", "preserved", "daemon-a"); s.fact("artifact", "removed");
  s.fact("consent", "preserved"); s.finish();
}

export async function productScenarios(h) {
  const cases = [["P01", productSetup], ["P02", productIsolation], ["P03", productIdle],
    ["P06", productReply], ["P04", productLongIdle], ["P05", productBusy],
    ["P08", productPolicy], ["P15", productSenderHome], ["P16", productFaults],
    ["P17", productNextTurn], ["P12", productRemoteNegative], ["P13", productExplicitModes],
    ["P14", productSessionChanges], ["P18", productMigration], ["P20", productPaths],
    ["P10", productEmbedded], ["P11", productDaemonRecovery], ["P09", productPolicyOff], ["P19", productUninstall]];
  for (const [id, execute] of cases) {
    if (h.caseFilter && !h.caseFilter.includes(id)) continue;
    await execute(h);
    if (h.untilCase === id) throw new Error(`requested partial diagnostic ended at ${id}; complete product matrix not certified`);
  }
}
