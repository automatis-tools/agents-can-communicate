import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ciFixture } from "../helpers/ci-fixture.mjs";
import { git, put } from "../helpers/change-plan-fixture.mjs";
const ci = await import("../../scripts/ci-plan.mjs").catch(() => ({}));
const api = () => assert.equal(typeof ci.createCiRoute, "function", "CI route implementation missing");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

for (const format of ["sha1", "sha256"]) test(`docs PR binds actual validation merge, compact exact route and ${format} objects`, async t => {
  api();
  const f = await ciFixture(t, { format });
  const { route, plan } = await ci.createCiRoute({ ...f, env: { ...f.env, SECRET: "do-not-transmit" } });
  assert.deepEqual(route, { schema: 1, eventName: "pull_request", ref: "refs/pull/17/merge", targetCommit: f.target,
    targetTree: await git(f.repo, "rev-parse", `${f.target}^{tree}`), baseCommit: f.base, headCommit: f.head,
    planDigest: plan.planDigest, discoveryDigest: plan.discoveryDigest, selectionDigest: plan.selectionDigest,
    scope: "docs", runId: "1234", runAttempt: "1", workers: ["docs-linux", "docs-macos", "docs-windows",
      "package-macos-latest", "package-ubuntu-latest", "package-windows-latest", "real-clients-ubuntu-latest", "real-clients-windows-latest"] });
  assert.notEqual(f.target, f.head);
  assert.deepEqual((await git(f.repo, "show", "-s", "--format=%P", f.target)).split(" "), [f.base, f.head]);
  assert.equal(f.target.length, format === "sha1" ? 40 : 64);
  assert.equal(plan.scope, "docs");
  const encoded = JSON.stringify(route);
  assert.ok(Buffer.byteLength(encoded) < 8192);
  assert.doesNotMatch(encoded, /selectedFiles|SECRET|do-not-transmit/);
  await ci.verifyCiInputs(f.repo, f.target);
  const shuffled = Object.fromEntries(Object.entries(route).reverse());
  assert.deepEqual(await ci.verifyCiRoute({ ...f, route: shuffled }), { route, plan });
});

test("foreign event context cannot reuse a correctly hashed route", async t => {
  api();
  const f = await ciFixture(t);
  const { route } = await ci.createCiRoute(f);
  const otherTree = await git(f.repo, "rev-parse", `${f.head}^{tree}`);
  const foreign = await git(f.repo, "commit-tree", otherTree, "-p", f.base, "-m", "foreign identity");
  const changes = [
    { env: { ...f.env, GITHUB_RUN_ID: "1235" } },
    { env: { ...f.env, GITHUB_EVENT_NAME: "workflow_dispatch" } },
    { env: { ...f.env, GITHUB_REF: "refs/pull/18/merge" }, event: { ...f.event, number: 18, pull_request: { ...f.event.pull_request, number: 18 } } },
    { event: { ...f.event, pull_request: { ...f.event.pull_request, base: { sha: f.head } } } },
    { event: { ...f.event, pull_request: { ...f.event.pull_request, head: { sha: foreign } } } },
  ];
  for (const change of changes) await assert.rejects(ci.verifyCiRoute({ ...f, ...change, route }), /ci-route-mismatch/);
  // Caller-side recomputation is possible; a plausible digest never authorizes supplied policy.
  for (const patch of [{ scope: "full" }, { workers: ["docs-linux"] }, { targetCommit: f.head },
    { planDigest: hash({ scope: "docs", selectedFiles: [] }) }, { selectionDigest: hash([]) }, { discoveryDigest: hash([]) },
    { workers: [...route.workers, "foreign"] }, { workers: [...route.workers, "docs-linux"] }]) {
    const forged = { ...route, ...patch };
    assert.match(hash(forged), /^[a-f0-9]{64}$/);
    await assert.rejects(ci.verifyCiRoute({ ...f, route: forged }), /ci-route-mismatch/);
  }
});

test("wrong actual same-tree commit cannot stand in for GITHUB_SHA", async t => {
  api();
  const f = await ciFixture(t);
  const { route } = await ci.createCiRoute(f);
  await git(f.repo, "checkout", "--detach", "-q", f.head);
  assert.equal(await git(f.repo, "rev-parse", "HEAD^{tree}"), route.targetTree);
  await assert.rejects(ci.verifyCiInputs(f.repo, f.target), /ci-checkout-commit-mismatch/);
  await assert.rejects(ci.verifyCiRoute({ ...f, route }), /ci-checkout-commit-mismatch/);
  await assert.rejects(ci.createCiRoute(f), /ci-checkout-commit-mismatch/);
});

for (const damage of ["tracked bytes", "ignored executable", "mode"]) test(`actual ${damage} must reject route despite unchanged Git target`, async t => {
  api();
  const f = await ciFixture(t);
  const { route } = await ci.createCiRoute(f);
  if (damage === "tracked bytes") {
    await git(f.repo, "config", "core.ignoreStat", "true");
    await put(f.repo, "README.md", "altered checkout\n");
  } else if (damage === "ignored executable") {
    await appendFile(path.join(f.repo, ".git/info/exclude"), "\nrogue.mjs\n");
    await put(f.repo, "rogue.mjs", "throw Error('ignored input');\n");
    assert.equal(await git(f.repo, "status", "--porcelain"), "");
  } else {
    if (process.platform === "win32") return t.skip("Windows does not enforce POSIX executable modes");
    await git(f.repo, "config", "core.fileMode", "false");
    await chmod(path.join(f.repo, "tests/runtime.test.mjs"), 0o755);
    assert.equal(await git(f.repo, "status", "--porcelain"), "");
  }
  await assert.rejects(ci.verifyCiInputs(f.repo, f.target), /ci-checkout-input-mismatch/);
  await assert.rejects(ci.verifyCiRoute({ ...f, route }), /ci-checkout-input-mismatch/);
  await assert.rejects(ci.createCiRoute(f), /ci-checkout-input-mismatch/);
});

test("malformed or missing event/run/PR identity cannot become a full passing proposal", async t => {
  api();
  const f = await ciFixture(t);
  const invalid = [
    ...["GITHUB_SHA", "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"].map(key => ({ env: { ...f.env, [key]: "" } })),
    ...["0", "01", "-1", "1.5", "1\n", 1].map(value => ({ env: { ...f.env, GITHUB_RUN_ID: value } })),
    { env: { ...f.env, GITHUB_RUN_ATTEMPT: "0" } }, { env: { ...f.env, GITHUB_SHA: "HEAD" } },
    { event: {} }, { event: { ...f.event, number: 0 } }, { event: { ...f.event, number: "17" } },
    { event: { ...f.event, pull_request: { ...f.event.pull_request, number: 18 } } },
    { env: { ...f.env, GITHUB_REF: "refs/pull/18/merge" } }, { env: { ...f.env, GITHUB_REF: "refs/pull/17/head" } },
    ...[null, "HEAD", "0".repeat(40), "f".repeat(39)].flatMap(sha => [
      { event: { ...f.event, pull_request: { ...f.event.pull_request, base: { sha } } } },
      { event: { ...f.event, pull_request: { ...f.event.pull_request, head: { sha } } } },
    ]),
  ];
  for (const change of invalid) await assert.rejects(ci.createCiRoute({ ...f, ...change }), /ci-context-invalid/);
  const { route } = await ci.createCiRoute(f);
  for (const supplied of [undefined, null, {}, { ...route, schema: undefined }, { ...route, schema: 2 },
    { ...route, extra: "x" }, { ...route, extra: "x".repeat(8192) }]) {
    await assert.rejects(ci.verifyCiRoute({ ...f, route: supplied }), /ci-route-(unsupported|mismatch)/);
  }
});

test("code changes, shallow history and unavailable ancestry retain full discovery", async t => {
  api();
  const full = await ciFixture(t, { scope: "full" });
  const code = await ci.createCiRoute(full);
  assert.equal(code.route.scope, "full");
  assert.ok(code.plan.selectedFiles.includes("tests/runtime.test.mjs"));
  const f = await ciFixture(t);
  const unknown = "f".repeat(40);
  for (const key of ["base", "head"]) {
    const event = { ...f.event, pull_request: { ...f.event.pull_request, [key]: { sha: unknown } } };
    const result = await ci.createCiRoute({ ...f, event });
    assert.equal(result.route.scope, "full");
    assert.ok(result.plan.reasons.includes("history-incomplete"));
  }
  await writeFile(path.join(f.repo, ".git/shallow"), `${f.base}\n`);
  assert.equal((await ci.createCiRoute(f)).route.scope, "full");
});

test("main/release/manual/unknown contexts never authorize docs", async t => {
  api();
  const f = await ciFixture(t);
  for (const [eventName, ref, event] of [
    ["push", "refs/heads/main", { before: f.base }], ["push", "refs/heads/release/next", { before: f.base }],
    ["release", "refs/tags/v1.0.0", {}], ["workflow_dispatch", "refs/heads/topic", {}],
    ["unrecognized", "refs/heads/topic", {}],
  ]) {
    const result = await ci.createCiRoute({ ...f, env: { ...f.env, GITHUB_EVENT_NAME: eventName, GITHUB_REF: ref }, event });
    assert.equal(result.route.scope, "full");
    assert.ok(result.plan.selectedFiles.includes("tests/runtime.test.mjs"));
    assert.equal(result.route.headCommit, null);
  }
  const pushed = await ci.createCiRoute({ ...f, env: { ...f.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/topic" }, event: { before: f.base } });
  assert.equal(pushed.route.scope, "docs");
});

test("push payload conflicts fail while absent or zero previous identities stay full", async t => {
  api();
  const f = await ciFixture(t);
  const env = { ...f.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/topic" };
  const matching = { before: f.base, after: f.target, ref: "refs/heads/topic" };
  assert.equal((await ci.createCiRoute({ ...f, env, event: matching })).route.scope, "docs");
  for (const patch of [{ after: f.head }, { ref: "refs/heads/main" }, { after: "" }, { ref: "" }]) {
    await assert.rejects(ci.createCiRoute({ ...f, env, event: { ...matching, ...patch } }), /ci-context-invalid/);
  }
  for (const before of [undefined, "HEAD", "0".repeat(40)]) {
    const { route } = await ci.createCiRoute({ ...f, env, event: { ...matching, before } });
    assert.equal(route.scope, "full");
    assert.equal(route.baseCommit, before === "0".repeat(40) ? before : null);
    assert.equal(route.headCommit, null);
  }
});

// Equality here would break ordinary retained-planner retries; Number would lose bounds.
test("retained planner keeps its lineage on later attempts with exact decimal bounds", async t => {
  const f = await ciFixture(t);
  const planner = "9007199254740992";
  const { route, plan } = await ci.createCiRoute({ ...f, env: { ...f.env, GITHUB_RUN_ATTEMPT: planner } });
  const env = { ...f.env, GITHUB_RUN_ATTEMPT: "9007199254740993" };
  assert.deepEqual(await ci.verifyCiRoute({ ...f, env, route }), { route, plan });
  for (const attempt of ["9007199254740994", "0", "01", "-1", "1.5", "1\n", 1, null, undefined]) {
    await assert.rejects(ci.verifyCiRoute({ ...f, env, route: { ...route, runAttempt: attempt } }));
  }
  await assert.rejects(ci.verifyCiRoute({ ...f, env: { ...env, GITHUB_RUN_ATTEMPT: "9007199254740991" }, route }));
  await assert.rejects(ci.verifyCiRoute({ ...f, env: { ...env, GITHUB_RUN_ATTEMPT: planner },
    route: { ...route, runAttempt: "9007199254740993" } }));
});
