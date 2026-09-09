import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPlan } from "../src/apply.mjs";
import { loadOwnership, recordInstall } from "../src/ownership.mjs";
import { livePolicyOf, readInstalledLivePolicy, readInstalledLivePolicyState } from "../src/live-policy.mjs";

async function dataHome(t, name = "acc-live-policy-") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), name)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the recorded delivery policy takes precedence over legacy activation", () => {
  assert.equal(livePolicyOf({ deliveryPolicy: "off",
    nativeActivation: { livePolicy: "all" } }), "off");
  assert.equal(livePolicyOf({ nativeActivation: { livePolicy: "actionable" } }), "actionable");
  assert.equal(livePolicyOf({ deliveryPolicy: "ALL",
    nativeActivation: { livePolicy: "all" } }), "off");
  assert.equal(livePolicyOf({}), "off");
});

test("the installed policy reader uses the ownership record", async t => {
  const root = await dataHome(t);
  await recordInstall({ dataHome: root, adapterId: "codex", version: "0.153.4",
    artifacts: [], deliveryPolicy: "all",
    nativeActivation: { livePolicy: "actionable", protocolContract: "legacy-v1",
      mechanisms: [] } });

  assert.equal((await loadOwnership({ dataHome: root })).installs[0].deliveryPolicy, "all");
  assert.equal(await readInstalledLivePolicy({ dataHome: root, adapterId: "codex" }), "all");
  assert.equal(await readInstalledLivePolicy({ dataHome: root, adapterId: "missing" }), "off");
});

test("apply records requested consent even when effective activation is off", async t => {
  const root = await dataHome(t, "acc-live-policy-apply-");
  const adapter = { id: "codex", install: async () => ({ changes: [] }) };
  const plan = { action: "install", skipped: [], operations: [{ adapterId: "codex",
    clientVersion: "0.153.4", livePolicy: "all", effectiveLivePolicy: "off", artifacts: [] }] };

  const result = await applyPlan({ plan, adapters: [adapter], context: { home: root },
    dataHome: root });

  assert.deepEqual(result.failed, []);
  const [install] = (await loadOwnership({ dataHome: root })).installs;
  assert.equal(install.deliveryPolicy, "all");
  assert.equal(install.nativeActivation, undefined);
});

test("missing and unknown installation records read off", async t => {
  const missing = await dataHome(t, "acc-live-policy-missing-");
  assert.equal(await readInstalledLivePolicy({ dataHome: missing, adapterId: "codex" }), "off");
  assert.deepEqual(await readInstalledLivePolicyState({ dataHome: missing, adapterId: "codex" }),
    { policy: "off", policyStatus: "missing" });

  const unknown = await dataHome(t, "acc-live-policy-unknown-");
  const file = path.join(unknown, "acc", "installs.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"schemaVersion":2,"installs":[]}\n');
  assert.equal(await readInstalledLivePolicy({ dataHome: unknown, adapterId: "codex" }), "off");
});

test("a corrupt installation record reads off without changing its bytes", async t => {
  const root = await dataHome(t, "acc-live-policy-corrupt-");
  const file = path.join(root, "acc", "installs.json");
  const bytes = Buffer.from("not valid json\n\u0000leave me alone\n");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);

  assert.equal(await readInstalledLivePolicy({ dataHome: root, adapterId: "codex" }), "off");
  assert.deepEqual(await readInstalledLivePolicyState({ dataHome: root, adapterId: "codex" }),
    { policy: "off", policyStatus: "unavailable" });
  assert.deepEqual(await readFile(file), bytes);
});
