import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
const ci = await import("../scripts/ci-plan.mjs").catch(() => ({}));

// A dropped auxiliary lane or a split docs Windows lane must fail these literal schedules.
const auxiliary = ["package-macos-latest", "package-ubuntu-latest", "package-windows-latest",
  "real-clients-ubuntu-latest", "real-clients-windows-latest"];
test("scope policy retains every auxiliary lane and complete platform test groups", () => {
  assert.equal(typeof ci.plannedCiWorkers, "function", "CI route implementation missing");
  assert.deepEqual(ci.plannedCiWorkers("docs"), ["docs-linux", "docs-macos", "docs-windows", ...auxiliary]);
  assert.deepEqual(ci.plannedCiWorkers("full"), ["full-linux", "full-macos", "full-windows-1", "full-windows-2", ...auxiliary]);
  for (const [platform, expected] of [["linux", ["docs-linux", "full-linux"]],
    ["darwin", ["docs-macos", "full-macos"]], ["win32", ["docs-windows", "full-windows-1", "full-windows-2"]]]) {
    assert.deepEqual(ci.platformTestWorkers(platform), expected);
  }
  for (const value of ["", "other", null, undefined]) {
    assert.throws(() => ci.plannedCiWorkers(value), /ci-scope-unsupported/);
    assert.throws(() => ci.platformTestWorkers(value), /ci-platform-unsupported/);
    assert.throws(() => ci.ciWorker(value), /ci-worker-unsupported/);
  }
});

test("fixed immutable worker roles cannot accept caller-provided policy", () => {
  assert.equal(typeof ci.ciWorker, "function", "CI route implementation missing");
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
  ];
  for (const [id, kind, platform, scope, shard, artifactName] of definitions) {
    const worker = ci.ciWorker(id);
    assert.deepEqual(worker, { id, kind, platform, scope, shard, artifactName });
    assert.ok(Object.isFrozen(worker));
    assert.throws(() => { worker.scope = "docs"; }, TypeError);
  }
  assert.throws(() => ci.ciWorker("toString"), /ci-worker-unsupported/);
});

test("route digest binds every field while ignoring object key order", () => {
  assert.equal(typeof ci.ciRouteDigest, "function", "CI route implementation missing");
  const literal = { schema: 1, scope: "full", workers: ["full-linux"], runId: "1234" };
  // Independently serialized canonical content; the hash implementation is not the oracle.
  const expected = createHash("sha256").update('{"runId":"1234","schema":1,"scope":"full","workers":["full-linux"]}').digest("hex");
  assert.equal(ci.ciRouteDigest(literal), expected);
  assert.equal(ci.ciRouteDigest({ workers: ["full-linux"], runId: "1234", scope: "full", schema: 1 }), expected);
  assert.notEqual(ci.ciRouteDigest({ ...literal, runId: "1235" }), expected);
});
