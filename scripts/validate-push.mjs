#!/usr/bin/env node
// The hook reads refs once. Attribution always precedes target content gates.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parsePushRefs, pushGit, resolvePushTrees, runPushCommand, withPushCheckout } from "./push-targets.mjs";
import { supportsSelection, withSelectionPlan } from "./push-selection.mjs";

async function supportsReceipt(checkout) {
  try {
    const manifest = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
    if (manifest.scripts?.test !== "node scripts/run-tests.mjs") return false;
    for (const file of ["run-tests.mjs", "test-shards.mjs"]) {
      const [target, trusted] = await Promise.all([readFile(path.join(checkout, "scripts", file)),
        readFile(path.join(import.meta.dirname, file))]);
      if (!target.equals(trusted)) return false;
    }
    return true;
  } catch { return false; }
}

try {
  const [flag, remote, ...extra] = process.argv.slice(2);
  if (flag !== "--remote" || !remote || extra.length) throw Error("usage: validate-push.mjs --remote NAME");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");
  const repo = (await pushGit(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
  const objectFormat = (await pushGit(repo, ["rev-parse", "--show-object-format"])).trim();
  const refs = parsePushRefs(input, { objectFormat });
  // npm's own Git children must read original objects too. Preserve the ordinary
  // test environment when no refs exist, including a custom replacement namespace.
  if ((await pushGit(repo, ["replace", "--list"])).trim()) process.env.GIT_NO_REPLACE_OBJECTS = "1";
  console.log("pre-push: refusing Claude attribution in pushed commits");
  await runPushCommand(process.execPath, [path.join(import.meta.dirname, "check-commit-attribution.mjs"),
    "--pre-push", remote], { cwd: repo, input });
  const targets = await resolvePushTrees(repo, refs, { planForRef: async ({ ref, commit, base }) => {
    // Even a broken planner import must retain attribution and full fallback.
    const { createGatePlan, validateGatePlan } = await import("./change-plan.mjs");
    const plan = await createGatePlan({ repo, targetCommit: commit, baseCommit: base,
      event: { kind: "push", ref: ref.remoteRef } });
    await validateGatePlan(plan, { repo });
    return plan;
  } });
  if (!targets.length) console.log("pre-push: deletions only; no content gates needed");
  console.log(`pre-push: resolved scopes ${JSON.stringify(targets.map(({ tree, requiredScope, refPlans }) =>
    ({ tree, scope: requiredScope, refs: refPlans.map(({ requiredScope: scope, plan }) =>
      ({ scope, planDigest: plan?.planDigest, selectionDigest: plan?.selectionDigest })) })))}`);

  for (const target of targets) {
    console.log(`pre-push: validating tree ${target.tree} (${target.requiredScope})`);
    await withPushCheckout(repo, target, async (checkout, signal) => {
      console.log("pre-push: syntax-checking actual target tracked .mjs files");
      await runPushCommand(process.execPath, [path.join(import.meta.dirname, "check-syntax.mjs"), "--tracked"],
        { cwd: checkout, signal });
      if (target.requiredScope === "measurement-only") {
        console.log("pre-push: measurement-only target; actual-target syntax passed; no suite");
      } else {
        const reuse = checkout === repo && await supportsReceipt(checkout);
        if (target.requiredScope === "docs" && await supportsSelection(checkout)) {
          console.log(`pre-push: running actual target's documentation subset (planDigest=${target.plan.planDigest}, selectionDigest=${target.plan.selectionDigest})`);
          await withSelectionPlan(target.plan, signal, file => runPushCommand("npm",
            ["test", "--", "--selection-plan", file, ...(reuse ? ["--if-needed"] : [])], { cwd: checkout, signal }));
        } else {
          console.log("pre-push: running actual target's full test suite");
          await runPushCommand("npm", ["test", ...(reuse ? ["--", "--if-needed"] : [])],
            { cwd: checkout, signal });
        }
      }
    });
  }
  console.log("pre-push: all gates passed");
} catch (error) {
  // Only our named failures escape: child output is printed with relative files.
  const named = /^(usage:|malformed |unsupported |unresolved |target |owned process |push validation interrupted)/.test(error.message);
  console.error(`pre-push: ${named ? error.message : "push repository facts unavailable"}`);
  process.exitCode = 1;
}
