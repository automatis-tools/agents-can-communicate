import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { connectMcp } from "../helpers/mcp-client.mjs";

const run = promisify(execFile);
const owner = session => ["--session", session.sessionId, "--generation", session.generation];

test("installed CLI batches contend atomically and release only owned resources", async t => {
  const f = await createPackedAcc(t);
  const a = await f.acc(["attach", "--participant", "alice", "--harness", "cli"]);
  assert.deepEqual(await f.acc(["release", ...owner(a), "--all"]), { claimIds: [] });
  const b = await f.acc(["attach", "--participant", "bob", "--harness", "cli"]);
  const contenders = [a, b];
  const attempts = contenders.map((session, index) => run(process.execPath,
    [f.accBin, "claim", ...owner(session), "--resource", `file:unique-${index}.mjs`,
      "--resource", "file:shared.mjs", "--cwd", f.project, "--json"],
    { cwd: f.project, env: f.env }).then(result => ({ code: 0, data: JSON.parse(result.stdout).data }),
    error => ({ code: error.code, error: JSON.parse(error.stdout).error })));
  const results = await Promise.all(attempts);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 5]);
  const winnerIndex = results.findIndex(result => result.code === 0);
  const winner = contenders[winnerIndex], loser = contenders[1 - winnerIndex];
  assert.deepEqual(results[winnerIndex].data.claims.map(claim => claim.resource),
    [`file:unique-${winnerIndex}.mjs`, "file:shared.mjs"]);
  assert.equal(results[1 - winnerIndex].error.details.conflicts[0].ownerSessionId, winner.sessionId);
  const status = await f.acc(["status"]);
  assert.equal(status.claims.length, 2);
  assert.equal(status.claims.every(claim => claim.ownerSessionId === winner.sessionId), true);
  const inspect = () => f.acc(["sync", "--scope", "full"]);
  const before = await inspect();
  const owned = await f.acc(["claim", ...owner(loser), "--resource", "file:loser-held.mjs"]);
  const withOwned = await inspect();
  const denied = await f.accError(["release", ...owner(loser), "--claim", owned.claimId,
    "--claim", results[winnerIndex].data.claims[0].claimId]);
  assert.equal(denied.code, 5);
  assert.deepEqual(await inspect(), withOwned);
  assert.equal((await f.acc(["release", ...owner(winner), "--all"])).claimIds.length, 2);
  assert.deepEqual((await f.acc(["status"])).claims.map(claim => claim.claimId), [owned.claimId]);
  const invalidBefore = await inspect();
  const invalid = await f.accError(["claim", ...owner(winner), "--resource", "file:new.mjs",
    "--resource", "file:invalid/*"]);
  assert.equal(invalid.code, 2);
  assert.deepEqual(await inspect(), invalidBefore);
  assert.equal(before.snapshot.claims.length, 2);
  const released = await f.acc(["release", ...owner(loser), "--resource", "file:loser-held.mjs"]);
  assert.deepEqual(released, { claimId: owned.claimId });
  assert.deepEqual((await f.acc(["status"])).claims, []);
});

test("installed MCP exposes array batches and preserves scalar responses", async t => {
  const f = await createPackedAcc(t);
  const cliOwner = await f.acc(["attach", "--participant", "cli_owner", "--harness", "cli"]);
  const cliClaim = await f.acc(["claim", ...owner(cliOwner), "--resource", "file:blocked.mjs"]);
  const client = connectMcp({ cwd: f.project, dataHome: f.dataHome,
    participant: "mcp_owner", binary: f.mcpBin, env: f.env });
  f.defer(() => client.close());
  await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "batch-installed-fixture", version: "1.0.0" } });
  client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = (name, args) => client.request("tools/call", { name, arguments: args });
  const acquired = await call("acc_claim", { action: "acquire",
    resources: ["file:a.mjs", "file:b.mjs"], reason: "batch" });
  assert.ok(acquired.result, JSON.stringify(acquired));
  assert.equal(acquired.result.isError, undefined, JSON.stringify(acquired));
  const claims = acquired.result.structuredContent.claims;
  assert.deepEqual(claims.map(claim => claim.resource), ["file:a.mjs", "file:b.mjs"]);
  const before = await f.acc(["sync", "--scope", "full"]);
  const conflict = await call("acc_claim", { action: "acquire",
    resources: ["file:a.mjs", "file:blocked.mjs"] });
  assert.equal(conflict.result.isError, true);
  assert.equal(conflict.result.structuredContent.details.conflicts[0].ownerSessionId, cliOwner.sessionId);
  assert.deepEqual((await f.acc(["sync", "--scope", "full"])).snapshot.claims, before.snapshot.claims);
  const released = await call("acc_release", { resources: ["file:a.mjs", "file:b.mjs"] });
  assert.deepEqual(released.result.structuredContent, { released: claims.map(claim => claim.claimId) });
  const one = await call("acc_claim", { action: "acquire", resource: "file:scalar.mjs" });
  assert.equal(one.result.structuredContent.resource, "file:scalar.mjs");
  assert.equal(one.result.structuredContent.claims, undefined);
  const scalarRelease = await call("acc_release", { claimId: one.result.structuredContent.claimId });
  assert.deepEqual(scalarRelease.result.structuredContent, { released: one.result.structuredContent.claimId });
  assert.deepEqual((await call("acc_release", { all: true })).result.structuredContent, { released: [] });
  assert.deepEqual((await f.acc(["status"])).claims.map(claim => claim.claimId), [cliClaim.claimId]);
});
