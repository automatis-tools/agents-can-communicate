#!/usr/bin/env node
// The hook reads refs once. Attribution always precedes target content gates.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parsePushRefs, pushGit, resolvePushTrees, runPushCommand, withPushCheckout } from "./push-targets.mjs";

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
  const targets = await resolvePushTrees(repo, refs);
  if (!targets.length) console.log("pre-push: deletions only; no content gates needed");
  // Import and report inside the boundary: even a broken observer cannot fail a gate.
  try {
    const { observePushPlans } = await import("./change-plan-observation.mjs");
    console.log(`pre-push: observation ${JSON.stringify(await observePushPlans(repo, targets))}`);
  } catch { console.log("pre-push: observation unavailable; existing gates unchanged"); }

  for (const target of targets) {
    console.log(`pre-push: validating tree ${target.tree} (${target.requiredScope})`);
    await withPushCheckout(repo, target, async (checkout, signal) => {
      console.log("pre-push: syntax-checking actual target tracked .mjs files");
      await runPushCommand(process.execPath, [path.join(import.meta.dirname, "check-syntax.mjs"), "--tracked"],
        { cwd: checkout, signal });
      if (target.requiredScope === "measurement-only") {
        console.log("pre-push: measurement-only target; actual-target syntax passed; no suite");
      } else {
        console.log("pre-push: running actual target's full test suite");
        const reuse = checkout === repo && await supportsReceipt(checkout);
        await runPushCommand("npm", ["test", ...(reuse ? ["--", "--if-needed"] : [])],
          { cwd: checkout, signal });
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
