// CI adapts actual event facts to the shared planner; routes never supply policy.
import { createHash } from "node:crypto";
import { createGatePlan, validateGatePlan } from "./change-plan.mjs";
import { gitBytes, gitText, isOid } from "./change-plan-git.mjs";
import { checkoutMatchesCommit } from "./push-tree-check.mjs";

const definitions = [
  ["full-linux", "test", "linux", "full", null, "test-timings-ubuntu-latest-node-24-full"],
  ["full-macos", "test", "darwin", "full", null, "test-timings-macos-latest-node-24-full"],
  ["full-windows-1", "test", "win32", "full", "1/2", "test-timings-windows-latest-node-24-shard-1-of-2"],
  ["full-windows-2", "test", "win32", "full", "2/2", "test-timings-windows-latest-node-24-shard-2-of-2"],
  ["docs-linux", "test", "linux", "docs", null, "test-timings-ubuntu-latest-node-24-docs"],
  ["docs-macos", "test", "darwin", "docs", null, "test-timings-macos-latest-node-24-docs"],
  ["docs-windows", "test", "win32", "docs", null, "test-timings-windows-latest-node-24-docs"],
  ["package-ubuntu-latest", "package", "linux", null, null, null],
  ["package-macos-latest", "package", "darwin", null, null, null],
  ["package-windows-latest", "package", "win32", null, null, null],
  ["real-clients-ubuntu-latest", "real-clients", "linux", null, null, null],
  ["real-clients-windows-latest", "real-clients", "win32", null, null, null],
].map(([id, kind, platform, scope, shard, artifactName]) => Object.freeze({ id, kind, platform, scope, shard, artifactName }));
const workers = new Map(definitions.map(worker => [worker.id, worker]));
export function ciWorker(workerId) {
  const worker = workers.get(workerId);
  if (!worker) throw Error("ci-worker-unsupported");
  return worker;
}
export function plannedCiWorkers(scope) {
  if (!["full", "docs"].includes(scope)) throw Error("ci-scope-unsupported");
  return definitions.filter(worker => worker.scope === null || worker.scope === scope).map(worker => worker.id).sort();
}
export function platformTestWorkers(platform) {
  if (!["linux", "darwin", "win32"].includes(platform)) throw Error("ci-platform-unsupported");
  return definitions.filter(worker => worker.kind === "test" && worker.platform === platform).map(worker => worker.id).sort();
}
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const serialize = value => JSON.stringify(canonical(value));
export const ciRouteDigest = route => createHash("sha256").update(serialize(route)).digest("hex");
const positive = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const exactOid = (value, target) => isOid(value) && value.length === target.length && !/^0+$/.test(value);

function eventFacts(env, event) {
  const { GITHUB_EVENT_NAME: eventName, GITHUB_REF: ref, GITHUB_SHA: targetCommit,
    GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt } = env ?? {};
  if (!isOid(targetCommit) || /^0+$/.test(targetCommit) || typeof eventName !== "string"
    || !/^[a-z][a-z0-9_]*$/.test(eventName) || typeof ref !== "string" || !ref.startsWith("refs/")
    || !positive(runId) || !positive(runAttempt)) throw Error("ci-context-invalid");
  let baseCommit = null;
  let headCommit = null;
  let policy = { kind: "unknown" };
  if (eventName === "pull_request") {
    const pr = event?.pull_request;
    if (!Number.isSafeInteger(event?.number) || event.number < 1 || !pr
      || (pr.number !== undefined && pr.number !== event.number) || ref !== `refs/pull/${event.number}/merge`
      || !exactOid(pr.base?.sha, targetCommit) || !exactOid(pr.head?.sha, targetCommit)) throw Error("ci-context-invalid");
    baseCommit = pr.base.sha;
    headCommit = pr.head.sha;
    policy = { kind: "pr", headCommit };
  } else if (eventName === "push") {
    if ((event?.after !== undefined && event.after !== targetCommit)
      || (event?.ref !== undefined && event.ref !== ref)) throw Error("ci-context-invalid");
    if (isOid(event?.before) && event.before.length === targetCommit.length) baseCommit = event.before;
    policy = { kind: "push", ref };
  } else if (eventName === "release") policy = { kind: "release" };
  return { eventName, ref, targetCommit, baseCommit, headCommit, runId, runAttempt, policy };
}

export async function verifyCiInputs(repo, targetCommit) {
  let head;
  try { head = (await gitText(repo, ["rev-parse", "--verify", "HEAD"])).trim(); }
  catch { throw Error("ci-checkout-commit-mismatch"); }
  if (!isOid(targetCommit) || head !== targetCommit) throw Error("ci-checkout-commit-mismatch");
  if (!await checkoutMatchesCommit(repo, targetCommit)) throw Error("ci-checkout-input-mismatch");
}
export async function createCiRoute({ repo, env, event }) {
  const { policy, ...facts } = eventFacts(env, event);
  try { await gitBytes(repo, ["check-ref-format", facts.ref]); }
  catch { throw Error("ci-context-invalid"); }
  await verifyCiInputs(repo, facts.targetCommit);
  const plan = await createGatePlan({ repo, targetCommit: facts.targetCommit, baseCommit: facts.baseCommit, event: policy });
  await validateGatePlan(plan, { repo });
  const route = { schema: 1, ...facts, targetTree: plan.targetTree, planDigest: plan.planDigest,
    discoveryDigest: plan.discoveryDigest, selectionDigest: plan.selectionDigest, scope: plan.scope,
    workers: Object.freeze(plannedCiWorkers(plan.scope)) };
  if (Buffer.byteLength(serialize(route)) > 8192) throw Error("ci-route-unsupported");
  return { route: Object.freeze(route), plan };
}
export async function verifyCiRoute({ repo, env, event, route }) {
  if (!route || route.schema !== 1 || Buffer.byteLength(serialize(route)) > 8192) throw Error("ci-route-unsupported");
  const expected = await createCiRoute({ repo, env, event });
  if (serialize(route) !== serialize(expected.route)) throw Error("ci-route-mismatch");
  return expected;
}
