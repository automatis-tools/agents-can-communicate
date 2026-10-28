// Immutable plans authorize supported local docs gates; all uncertainty requires full.
import { createHash } from "node:crypto";

export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const validPath = file => typeof file === "string" && file.length > 0 && file.isWellFormed()
  && !/[\\\0]/.test(file) && !file.split("/").some(part => ["", ".", ".."].includes(part));
const roots = ["docs", "examples"];
const docs = ["AGENTS.md", "CHANGELOG.md", "README.md", "SECURITY.md"];
export function validManifest(manifest) {
  return manifest?.schema === 1 && Array.isArray(manifest.documentation)
    && Array.isArray(manifest.documentationRoots) && JSON.stringify(manifest.documentation.slice().sort()) === JSON.stringify(docs)
    && JSON.stringify(manifest.documentationRoots.slice().sort()) === JSON.stringify(roots)
    && Array.isArray(manifest.externalReaders) && manifest.externalReaders.every(file => validPath(file)
      && /^(tests|packages)\/.+\.test\.mjs$/.test(file)) && /^[a-f0-9]{64}$/.test(manifest.sourceDigest);
}
export const documentationPath = file => validPath(file)
  && (docs.includes(file) || /^(docs|examples)\/[\s\S]+\.md$/.test(file));

export function classifyChanges({ changes, complete, ancestryVerified, manifest }) {
  const full = reason => ({ scope: "full", reasons: [reason] });
  if (!validManifest(manifest)) return full("manifest-unsupported");
  if (!complete || !ancestryVerified) return full("history-incomplete");
  if (!Array.isArray(changes) || !changes.length) return full("changes-empty");
  for (const change of changes) {
    const { status, oldPath, newPath, oldMode, newMode } = change ?? {};
    const oldAbsent = oldPath === null && oldMode === null;
    const newAbsent = newPath === null && newMode === null;
    const ordinaryOld = documentationPath(oldPath) && oldMode === "100644";
    const ordinaryNew = documentationPath(newPath) && newMode === "100644";
    const valid = status === "A" ? oldAbsent && ordinaryNew
      : status === "D" ? ordinaryOld && newAbsent
        : status === "M" ? ordinaryOld && ordinaryNew && oldPath === newPath
          : ["R", "C"].includes(status) && ordinaryOld && ordinaryNew;
    if (!valid) return full("changes-require-full");
  }
  return { scope: "docs", reasons: ["ordinary-documentation-only"] };
}

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { discoverTreeTests } from "./validation-discovery.mjs";
import { gitBytes, gitText, isOid, parseRawChanges, readTree, resolveCommit, treeBlob } from "./change-plan-git.mjs";

const manifestPath = "scripts/validation-impact.json";
const externalReaders = ["tests/acceptance/package-links.test.mjs", "tests/acceptance/packaging.test.mjs",
  "tests/acceptance/recorded-candidate.test.mjs", "tests/package-certification.test.mjs",
  "tests/process/orchestration-is-absent.test.mjs", "tests/process/session-resolution.test.mjs",
  "tests/process/surface-coverage.test.mjs"];
const sorted = values => [...new Set(values)].sort();
// This audit deliberately covers source/config/helper additions too, including dynamic readers.
// Refresh only after a source-driven reader audit, never automatically during planning.
export const sourceDigest = entries => digest(entries.filter(entry => entry.path !== manifestPath
  && !documentationPath(entry.path)).map(({ path, mode, type, oid }) => [path, mode, type, oid])
  .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hashPlan = plan => digest(canonical(plan));
const freeze = plan => Object.freeze(Object.fromEntries(Object.entries(plan).map(([key, value]) =>
  [key, Array.isArray(value) ? Object.freeze(value) : value])));

async function targetFacts(repo, targetCommit) {
  const target = await resolveCommit(repo, targetCommit);
  const entries = await readTree(repo, target.tree);
  if (entries.some(entry => !validPath(entry.path))) throw Error("target-path-unsupported");
  const discovery = discoverTreeTests(entries);
  if (!discovery.length) throw Error("target-discovery-empty");
  let manifest = null;
  try { manifest = JSON.parse(await treeBlob(repo, entries, manifestPath)); } catch { /* Full proposal. */ }
  const manifestEntry = entries.find(entry => entry.path === manifestPath);
  const manifestDigest = hashPlan(manifest ?? { unavailable: manifestEntry?.oid ?? null });
  return { target, entries, discovery, manifest, manifestDigest };
}
function eventContext(event, targetCommit) {
  const context = typeof event === "string" ? { kind: event } : event ?? {};
  const reasons = [`event:${["push", "pr", "release"].includes(context.kind) ? context.kind : "unknown"}`];
  let allowed = false;
  if (context.kind === "push") {
    const ref = context.ref;
    if (typeof ref === "string" && /^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(ref)) {
      reasons.push(`ref:${ref}`);
      allowed = ref !== "refs/heads/main" && !/^refs\/heads\/release(?:[/-]|$)/.test(ref);
    }
  } else if (context.kind === "pr") {
    // CLI's exact target is its head. CI may supply a separate head for a validation merge.
    const head = context.headCommit ?? targetCommit;
    if (isOid(head)) { reasons.push(`head-commit:${head}`); allowed = true; }
  }
  if (!allowed) reasons.push("event-requires-full");
  return { reasons, allowed };
}
export async function createGatePlan({ repo, targetCommit, baseCommit, event }) {
  const { target, entries, discovery, manifest, manifestDigest } = await targetFacts(repo, targetCommit);
  const context = eventContext(event, targetCommit);
  const reasons = [...context.reasons];
  let baseTree = null;
  let changes = [];
  let complete = false;
  let ancestryVerified = false;
  let copyOriginAmbiguous = false;
  try {
    const base = await resolveCommit(repo, baseCommit);
    baseTree = base.tree;
    reasons.push(`base-commit:${base.commit}`);
    if ((await gitText(repo, ["rev-parse", "--is-shallow-repository"])).trim() !== "false") throw Error("shallow");
    await gitBytes(repo, ["merge-base", "--is-ancestor", base.commit, target.commit]);
    const head = reasons.find(reason => reason.startsWith("head-commit:"))?.slice(12);
    if (head) {
      await resolveCommit(repo, head);
      await gitBytes(repo, ["merge-base", "--is-ancestor", head, target.commit]);
    }
    ancestryVerified = true;
    changes = parseRawChanges(await gitBytes(repo, ["diff", "--raw", "-z", "--no-ext-diff", "--no-textconv",
      "--find-renames", "--find-copies-harder", "-l0", base.commit, target.commit, "--"]));
    // Copy detection chooses one best source. An edited source or an identical
    // non-doc alternative cannot establish a documentation-only origin.
    const baseEntries = await readTree(repo, base.tree);
    const nonDocs = new Set(baseEntries.filter(entry => !documentationPath(entry.path)
      || entry.mode !== "100644").map(entry => entry.oid));
    const targetBlobs = new Map(entries.map(entry => [entry.path, entry.oid]));
    const baseBlobs = new Map(baseEntries.map(entry => [entry.path, entry.oid]));
    copyOriginAmbiguous = changes.some(change => {
      if (!["A", "C", "R"].includes(change.status) || !documentationPath(change.newPath)) return false;
      const targetOid = targetBlobs.get(change.newPath);
      const sourceOid = baseBlobs.get(change.oldPath);
      return nonDocs.has(targetOid) || (["C", "R"].includes(change.status)
        && (!sourceOid || !targetOid || sourceOid !== targetOid || nonDocs.has(sourceOid)));
    });
    if (copyOriginAmbiguous) reasons.push("copy-origin-ambiguous");
    complete = true;
  } catch { reasons.push("history-incomplete"); }
  const classification = classifyChanges({ changes, complete, ancestryVerified, manifest });
  reasons.push(...classification.reasons);
  const selectedDocs = discovery.filter(file => file.startsWith("tests/docs/") || (Array.isArray(manifest?.externalReaders) && manifest.externalReaders.includes(file)));
  let scope = context.allowed && !copyOriginAmbiguous ? classification.scope : "full";
  if (!validManifest(manifest) || externalReaders.some(file => !manifest.externalReaders.includes(file)
    || !discovery.includes(file)) || !selectedDocs.some(file => file.startsWith("tests/docs/"))) {
    scope = "full"; reasons.push("docs-selection-incomplete");
  }
  if (manifest?.sourceDigest !== sourceDigest(entries)) { scope = "full"; reasons.push("reader-audit-drift"); }
  if (entries.some(entry => entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))) {
    scope = "full"; reasons.push("target-topology-unsupported");
  }
  const selectedFiles = scope === "docs" ? selectedDocs : discovery;
  const plan = { schema: 1, scope, targetCommit: target.commit, targetTree: target.tree, baseTree,
    manifestDigest, discoveryDigest: digest(discovery), selectionDigest: digest(selectedFiles), selectedFiles,
    requiredLanes: ["attribution", "package", "syntax", scope === "docs" ? "test-docs" : "test"], reasons: sorted(reasons) };
  return freeze({ ...plan, planDigest: hashPlan(plan) });
}
export async function validateGatePlan(plan, { repo, discovery } = {}) {
  if (plan?.schema !== 1 || !["docs", "full"].includes(plan.scope) || !Array.isArray(plan.reasons)
    || !plan.reasons.every(reason => typeof reason === "string")) throw Error("plan-unsupported");
  const { planDigest, ...body } = plan;
  if (hashPlan(body) !== planDigest) throw Error("plan-digest-mismatch");
  const get = prefix => plan.reasons.filter(reason => reason.startsWith(prefix));
  for (const prefix of ["event:", "ref:", "head-commit:", "base-commit:"]) {
    if (get(prefix).length > 1) throw Error("plan-context-ambiguous");
  }
  const event = { kind: get("event:")[0]?.slice(6), ref: get("ref:")[0]?.slice(4),
    headCommit: get("head-commit:")[0]?.slice(12) };
  const expected = await createGatePlan({ repo, targetCommit: plan.targetCommit,
    baseCommit: get("base-commit:")[0]?.slice(12), event });
  if (hashPlan(expected) !== hashPlan(plan)) throw Error("plan-facts-mismatch");
  if (discovery !== undefined && digest(discovery) !== expected.discoveryDigest) throw Error("plan-discovery-mismatch");
}

async function cli(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!["--base", "--target", "--event", "--output", "--ref", "--head"].includes(key)
      || options[key] !== undefined || !args[index + 1]) throw Error("usage");
    options[key] = args[index + 1];
  }
  if (!["pr", "push", "release"].includes(options["--event"]) || !options["--output"]
    || !isOid(options["--target"]) || !isOid(options["--base"])) throw Error("usage");
  const repo = process.cwd();
  const plan = await createGatePlan({ repo, targetCommit: options["--target"], baseCommit: options["--base"],
    event: { kind: options["--event"], ref: options["--ref"], headCommit: options["--head"] } });
  await validateGatePlan(plan, { repo });
  const output = path.resolve(options["--output"]);
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" }); await rename(temporary, output); }
  finally { await rm(temporary, { force: true }); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await cli(process.argv.slice(2)); }
  catch { console.error("change-plan: plan unavailable; retain full gates"); process.exitCode = 1; }
}
