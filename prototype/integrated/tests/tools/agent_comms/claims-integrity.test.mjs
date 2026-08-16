import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { claimScope, extendClaims, releaseScope }
  from "../../../tools/agents/lib/claims.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { validateClaim } from "../../../tools/agents/lib/schema.mjs";
import { createBusFixture, seedOpenAgent } from "./helpers.mjs";

async function setup(t) {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = { ...fixture.context, pid: 4242, pidIsAlive: () => false,
    randomUUID: () => "00000000-0000-4000-8000-000000000001" };
  await seedOpenAgent(context, { agentId: "visual", task: "M2.7" });
  const claim = validateClaim({ schema_version: 1, agent_id: "visual", task: "M2.7",
    scope: "game/presentation", reason: "camera", created_at: context.now().toISOString(),
    updated_at: context.now().toISOString(),
    expires_at: new Date(context.now().getTime() + 60_000).toISOString() });
  const canonical = path.join(context.paths.claims,
    `${createHash("sha256").update(claim.scope).digest("hex")}.json`);
  const wrong = path.join(context.paths.claims, "wrong-name.json");
  const bytes = `${JSON.stringify(claim)}\n`;
  await Promise.all([writeFile(canonical, bytes), writeFile(wrong, bytes)]);
  return { context, canonical, wrong, bytes };
}

for (const [name, mutate] of [
  ["claim", context => claimScope(context,
    { agentId: "visual", scope: "game/presentation", reason: "renew" })],
  ["release", context => releaseScope(context,
    { agentId: "visual", scope: "game/presentation" })],
  ["extend", context => extendClaims(context, "visual")],
]) test(`${name} rejects duplicate scope and wrong digest before mutation`, async t => {
  const { context, canonical, wrong, bytes } = await setup(t);
  await assert.rejects(mutate(context), error => error.exitCode === EXIT.DATA);
  assert.equal(await readFile(canonical, "utf8"), bytes);
  assert.equal(await readFile(wrong, "utf8"), bytes);
});
