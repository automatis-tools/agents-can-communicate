// An explicit plan is untrusted input. Any uncertainty restores full discovery.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateGatePlan } from "./change-plan.mjs";
import { checkoutMatchesCommit } from "./push-tree-check.mjs";
import { shardFiles } from "./test-shards.mjs";

export async function resolveTestSelection({ repo, files, options }) {
  const full = { scope: "full", kind: "test", files, fullCount: files.length };
  if (!options.selectionPlan) return { ...full, files: shardFiles(files, options.shard) };
  try {
    const plan = JSON.parse(await readFile(path.resolve(repo, options.selectionPlan), "utf8"));
    const discovery = files.map(file => path.relative(repo, file).split(path.sep).join("/")).sort();
    await validateGatePlan(plan, { repo, discovery });
    if (!await checkoutMatchesCommit(repo, plan.targetCommit)) throw Error("checkout-mismatch");
    if (plan.scope === "full") return { ...full, plan };
    const selected = new Set(plan.selectedFiles);
    return { scope: "docs", kind: "test-docs", files: files.filter(file => selected.has(path.relative(repo, file).split(path.sep).join("/"))),
      fullCount: files.length, plan };
  } catch {
    // Never expose parser errors, plan bytes, refs or filesystem paths.
    return { ...full, fallbackReason: "selection-plan-unavailable-or-invalid" };
  }
}
