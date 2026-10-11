import assert from "node:assert/strict";
import test from "node:test";

import { withServer } from "./stdio-harness.mjs";

const call = (request, meta, name, args) => request("tools/call",
  { name, arguments: args, _meta: meta }).then(response => response.result);
const readSnapshot = (request, meta) => request("resources/read",
  { uri: "acc://snapshot", _meta: meta })
  .then(response => JSON.parse(response.result.contents[0].text));
const success = result => {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
  return result.structuredContent;
};

test("MCP acquires resources in one batch with common options and stable array responses", async t => {
  await withServer(t, async ({ request, meta }) => {
    const args = { action: "acquire", resources: ["file:./src/a.mjs", "doc:guide#api"],
      mode: "shared", reason: "Reviewing both", leaseSeconds: 60 };
    const { claims } = success(await call(request, meta, "acc_claim", args));
    assert.deepEqual(claims.map(claim => claim.resource), ["file:src/a.mjs", "doc:guide#api"]);
    for (const claim of claims) {
      assert.equal(claim.mode, "shared");
      assert.equal(claim.reason, "Reviewing both");
      assert.equal(claim.enforcement, "advisory");
      assert.equal(Date.parse(claim.expiresAt) - Date.parse(claim.acquiredAt), 60_000);
    }
    const single = success(await call(request, meta, "acc_claim",
      { action: "acquire", resources: ["file:src/a.mjs"] }));
    assert.deepEqual(Object.keys(single), ["claims"]);
    assert.equal(single.claims.length, 1);
    assert.equal(single.claims[0].claimId, claims[0].claimId);
    assert.equal(single.claims[0].mode, "exclusive");
    const renewed = success(await call(request, meta, "acc_claim",
      { action: "renew", claimId: claims[1].claimId, leaseSeconds: 120 }));
    assert.equal(renewed.claimId, claims[1].claimId);
    assert.equal(renewed.claims, undefined);
  });
});

test("MCP batch conflict leaves every claim unchanged and exposes all blocker owners", async t => {
  await withServer(t, async ({ request, meta, workspace, dataHome }) => {
    const own = success(await call(request, meta, "acc_claim",
      { action: "acquire", resource: "file:own.mjs", reason: "Original reason" }));
    const blockers = [];
    for (const [participant, resource] of [["source_peer", "file:src/**"],
      ["docs_peer", "file:docs/**"]]) {
      await withServer(t, async peer => {
        blockers.push(success(await call(peer.request, peer.meta, "acc_claim",
          { action: "acquire", resource })));
      }, { reuse: { workspace, dataHome }, env: { ACC_MCP_PARTICIPANT: participant } });
    }
    const rejected = await call(request, meta, "acc_claim", { action: "acquire",
      resources: ["file:own.mjs", "file:free.mjs", "file:src/api.mjs", "file:docs/guide.md"],
      reason: "Must not commit" });
    assert.equal(rejected.isError, true);
    const snapshot = await readSnapshot(request, meta);
    assert.equal(snapshot.claims.length, 3);
    assert.deepEqual(snapshot.claims.find(claim => claim.claimId === own.claimId), own);
    assert.equal(snapshot.claims.some(claim => claim.resource === "file:free.mjs"), false);
    assert.equal(typeof rejected.structuredContent, "object", "batch conflicts need structured details");
    assert.equal(rejected.structuredContent.code, 5);
    assert.deepEqual(rejected.structuredContent.details.conflicts.map(conflict => ({
      requestedResource: conflict.requestedResource, resource: conflict.resource,
      claimId: conflict.claimId, ownerSessionId: conflict.ownerSessionId,
    })), [
      { requestedResource: "file:src/api.mjs", resource: "file:src/**",
        claimId: blockers[0].claimId, ownerSessionId: blockers[0].ownerSessionId },
      { requestedResource: "file:docs/guide.md", resource: "file:docs/**",
        claimId: blockers[1].claimId, ownerSessionId: blockers[1].ownerSessionId },
    ]);
  });
});

test("MCP release selectors preserve scalar results and explicit single-item arrays", async t => {
  await withServer(t, async ({ request, meta }) => {
    const acquire = resource => call(request, meta, "acc_claim", { action: "acquire", resource })
      .then(success);
    const first = await acquire("file:first.mjs");
    const second = await acquire("file:second.mjs");
    const third = await acquire("file:third.mjs");
    const fourth = await acquire("file:fourth.mjs");
    assert.deepEqual(success(await call(request, meta, "acc_release", { claimId: first.claimId })),
      { released: first.claimId });
    assert.deepEqual(success(await call(request, meta, "acc_release", { resource: "file:./second.mjs" })),
      { released: second.claimId });
    assert.deepEqual(success(await call(request, meta, "acc_release", { claimIds: [third.claimId] })),
      { released: [third.claimId] });
    assert.deepEqual(success(await call(request, meta, "acc_release", { resources: ["file:fourth.mjs"] })),
      { released: [fourth.claimId] });
    assert.deepEqual((await readSnapshot(request, meta)).claims, []);
  });
});

test("MCP batch release by IDs and resources rejects a failed selector without partial release", async t => {
  await withServer(t, async ({ request, meta }) => {
    const first = success(await call(request, meta, "acc_claim", { action: "acquire",
      resource: "file:first.mjs" }));
    const second = success(await call(request, meta, "acc_claim", { action: "acquire",
      resource: "file:second.mjs" }));
    for (const selector of [{ claimIds: [first.claimId, "claim_missing"] },
      { resources: ["file:first.mjs", "file:missing.mjs"] }]) {
      assert.equal((await call(request, meta, "acc_release", selector)).isError, true);
      assert.deepEqual((await readSnapshot(request, meta)).claims.map(claim => claim.claimId).sort(),
        [first.claimId, second.claimId].sort());
    }
    const released = success(await call(request, meta, "acc_release",
      { resources: ["file:second.mjs", "file:first.mjs"] }));
    assert.deepEqual(released, { released: [second.claimId, first.claimId] });
    const again = success(await call(request, meta, "acc_claim",
      { action: "acquire", resources: ["file:first.mjs", "file:second.mjs"] }));
    assert.deepEqual(success(await call(request, meta, "acc_release",
      { claimIds: again.claims.map(claim => claim.claimId) })),
    { released: again.claims.map(claim => claim.claimId) });
  });
});

test("MCP release all removes only this session's claims and keeps its intent and presence open", async t => {
  await withServer(t, async ({ request, meta, workspace, dataHome }) => {
    success(await call(request, meta, "acc_work", { summary: "Still editing", mode: "edit" }));
    const { claims } = success(await call(request, meta, "acc_claim",
      { action: "acquire", resources: ["file:first.mjs", "file:second.mjs"] }));
    let peerClaim;
    await withServer(t, async peer => {
      peerClaim = success(await call(peer.request, peer.meta, "acc_claim",
        { action: "acquire", resource: "file:peer.mjs" }));
    }, { reuse: { workspace, dataHome }, env: { ACC_MCP_PARTICIPANT: "release_peer" } });
    assert.deepEqual(success(await call(request, meta, "acc_release", { all: true })).released.sort(),
      claims.map(claim => claim.claimId).sort());
    const snapshot = await readSnapshot(request, meta);
    assert.deepEqual(snapshot.claims, [peerClaim]);
    assert.equal(snapshot.sessions.find(session => session.sessionId === claims[0].ownerSessionId).state,
      "open");
    assert.equal(snapshot.intents.find(intent => intent.sessionId === claims[0].ownerSessionId).summary,
      "Still editing");
    assert.deepEqual(success(await call(request, meta, "acc_release", { all: true })), { released: [] });
  });
});

test("MCP release all succeeds for an empty solo ephemeral session", async t => {
  await withServer(t, async ({ request, meta }) => {
    assert.deepEqual(success(await call(request, meta, "acc_release", { all: true })), { released: [] });
    const roster = await request("resources/read", { uri: "acc://roster", _meta: meta });
    const [session] = JSON.parse(roster.result.contents[0].text);
    assert.equal(session.participantId, "mcp_client");
    assert.equal(session.presence, "online");
  });
});
