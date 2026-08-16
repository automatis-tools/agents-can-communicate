import assert from "node:assert/strict";
import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../../../tools/agents/lib/atomic-json.mjs";
import { claimScope } from "../../../tools/agents/lib/claims.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { ackMessage, markSeen, sendMessage } from "../../../tools/agents/lib/messages.mjs";
import { validateHandoff, validateProtocol } from "../../../tools/agents/lib/schema.mjs";
import { collectStatus, enforcementExit, runDoctor } from "../../../tools/agents/lib/status.mjs";
import {
  createBusFixture, messageRequest, pathExists, seedOpenAgent, seedPresence,
} from "./helpers.mjs";

async function fixtureFor(t) {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = {
    ...fixture.context,
    pid: 4242,
    pidIsAlive: pid => pid === 4242,
    randomUUID: (() => {
      let index = 0;
      return () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`;
    })(),
    listActiveAgentIds: async () => ["visual", "models", "offline"],
  };
  await Promise.all([
    seedOpenAgent(context, { agentId: "visual", task: "M2.7" }),
    seedOpenAgent(context, { agentId: "models", task: "M2.7" }),
    seedOpenAgent(context, { agentId: "offline", task: "M2.7" }),
  ]);
  await seedPresence(context, { agentId: "visual", pid: 4242 });
  await seedPresence(context, { agentId: "models", pid: 4242 });
  const protocol = validateProtocol({
    schema_version: 1,
    protocol_version: 1,
    checkout_id: "c".repeat(64),
    checkout_root: fixture.root,
    initialized_at: context.now().toISOString(),
  });
  await writeJsonAtomic(context.paths.protocol, protocol,
    { tmpDir: context.paths.tmp, exclusive: true });
  return { ...fixture, context };
}

async function requiredMessage(context, overrides = {}) {
  return sendMessage(context, messageRequest(overrides));
}

async function seedClaimLock(context, ageMs = 60_001) {
  const directory = path.join(context.paths.locks, "claims.lock");
  await mkdir(directory);
  await writeFile(path.join(directory, "owner.json"), `${JSON.stringify({
    schema_version: 1,
    owner_agent: "visual",
    pid: 9999,
    acquired_at: new Date(context.now().getTime() - ageMs).toISOString(),
  })}\n`);
  return directory;
}

function watcherOwner(context, overrides = {}) {
  return {
    schema_version: 1,
    agent_id: "models",
    pid: 9999,
    token: "11111111-1111-4111-8111-111111111111",
    acquired_at: new Date(context.now().getTime() - 60_001).toISOString(),
    ...overrides,
  };
}

test("seen required action stays pending until acknowledgement", async t => {
  const { context } = await fixtureFor(t);
  const message = await requiredMessage(context);
  await markSeen(context, message, "models");
  const report = await collectStatus(context);
  assert.equal(report.counts.seen_but_unacked, 1);
  assert.equal(report.counts.required_unacked, 1);
  assert.deepEqual(report.protocol,
    { schema_version: 1, protocol_version: 1, checkout_id: "c".repeat(64) });
  assert.deepEqual(report.messages.required_unacked, [message]);
});

test("validated acknowledgement is visible to the original sender", async t => {
  const { context } = await fixtureFor(t);
  const message = await requiredMessage(context);
  const acknowledgement = await ackMessage(context,
    { agentId: "models", messageId: message.id });
  const report = await collectStatus(context);
  assert.deepEqual(report.messages.acknowledgements, [{
    message, acknowledgement, location: "archive",
  }]);
  assert.equal(report.counts.acknowledgements, 1);
  assert.deepEqual(report.messages.required_unacked, []);
});

test("ack filename cannot impersonate acknowledgement of another message", async t => {
  const { context } = await fixtureFor(t);
  const message = await requiredMessage(context);
  const ackPath = context.paths.ackFile(message.id, "models");
  await writeFile(ackPath, `${JSON.stringify({
    schema_version: 1,
    message_id: `${message.id}-other`,
    recipient: "models",
    acknowledged_at: context.now().toISOString(),
  })}\n`);
  const report = await collectStatus(context);
  assert.deepEqual(report.messages.acknowledgements, []);
  assert.deepEqual(report.corrupt, [ackPath]);
});

test("status distinguishes agents, messages, claims, blockers, and handoffs", async t => {
  const { context, clock } = await fixtureFor(t);
  await seedPresence(context, { agentId: "models", pid: 4242,
    heartbeatAt: new Date(context.now().getTime() - 45_001).toISOString() });
  const blocker = await requiredMessage(context,
    { type: "blocker", severity: "blocker", subject: "Blocked" });
  const info = await requiredMessage(context, { type: "status", severity: "info",
    subject: "FYI", requiresAck: false });
  await markSeen(context, info, "models");
  await claimScope(context, { agentId: "visual", scope: "game/presentation",
    reason: "camera", leaseSeconds: 1 });
  clock.advance(1_001);
  await claimScope(context, { agentId: "models", scope: "game/models",
    reason: "mesh", leaseSeconds: 10 });
  const handoff = validateHandoff({
    schema_version: 1, id: "handoff-one", from: "visual", to: "models",
    task: "M2.7", result: "ready", branch: "models", commit: "d".repeat(40),
    base: "a".repeat(40), changed_paths: ["game/models"],
    verification: [{ command: "node --test", exitCode: 0, summary: "pass" }],
    contracts: { added: [], changed: [], consumed: [] }, follow_up: [], artifacts: [],
    limitations: [], uncommitted: false, ready_to_merge: true, state: "READY",
    created_at: context.now().toISOString(),
  });
  await writeJsonAtomic(context.paths.handoffFile(handoff.id), handoff,
    { tmpDir: context.paths.tmp, exclusive: true });
  const report = await collectStatus(context);
  assert.deepEqual(report.agents.live.map(item => item.agent_id), ["visual"]);
  assert.deepEqual(report.agents.stale.map(item => item.agent_id), ["models"]);
  assert.deepEqual(report.agents.offline.map(item => item.agent_id), ["offline"]);
  assert.deepEqual(report.messages.unseen, [blocker]);
  assert.deepEqual(report.messages.seen_but_unacked, [info]);
  assert.deepEqual(report.messages.blockers, [blocker]);
  assert.deepEqual(report.claims.stale.map(item => item.scope), ["game/presentation"]);
  assert.deepEqual(report.claims.active.map(item => item.scope), ["game/models"]);
  assert.deepEqual(report.handoffs, [handoff]);
  assert.equal(enforcementExit(report, { failOnPending: true }), EXIT.REQUIRED);
  await ackMessage(context, { agentId: "models", messageId: blocker.id });
  assert.equal(enforcementExit(await collectStatus(context), { failOnPending: true }), EXIT.OK);
});

test("require-live and fail-on-stale report required agents only", async t => {
  const { context } = await fixtureFor(t);
  const report = await runDoctor(context, { requireLive: ["models", "offline"] });
  assert.deepEqual(report.issues.map(issue => issue.code), ["REQUIRED_AGENT_OFFLINE"]);
  const status = await collectStatus(context);
  assert.equal(enforcementExit(status, { failOnStale: true }), EXIT.OK);
  await seedPresence(context, { agentId: "models", pid: 4242,
    heartbeatAt: new Date(context.now().getTime() - 45_001).toISOString() });
  assert.equal(enforcementExit(await collectStatus(context), { failOnStale: true }),
    EXIT.REQUIRED);
});

test("doctor reports corrupt JSON read-only and repair quarantines with immutable audit", async t => {
  const { context, clock } = await fixtureFor(t);
  const corruptPath = context.paths.inboxFile("models", "broken");
  await mkdir(path.dirname(corruptPath), { recursive: true });
  await writeFile(corruptPath, "{not-json");
  const normal = await runDoctor(context, {});
  assert.equal(normal.ok, false);
  assert.equal(normal.issues[0].code, "CORRUPT_JSON");
  assert.equal(await pathExists(corruptPath), true);
  assert.equal(enforcementExit(await collectStatus(context), {}), EXIT.DATA);
  const repaired = await runDoctor(context, { repair: true });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.repairs[0].action, "quarantine_corrupt_json");
  assert.equal(await pathExists(corruptPath), false);
  const auditPath = repaired.repairs[0].audit_path;
  const before = await readFile(auditPath, "utf8");
  clock.advance(1_000);
  await mkdir(path.dirname(corruptPath), { recursive: true });
  await writeFile(corruptPath, "{not-json");
  await runDoctor(context, { repair: true });
  assert.equal(await readFile(auditPath, "utf8"), before);
});

test("doctor finishes only an acknowledgement-backed archive move", async t => {
  const { context } = await fixtureFor(t);
  const message = await requiredMessage(context);
  await writeJsonAtomic(context.paths.ackFile(message.id, "models"), {
    schema_version: 1, message_id: message.id, recipient: "models",
    acknowledged_at: context.now().toISOString(),
  }, { tmpDir: context.paths.tmp, exclusive: true });
  const normal = await runDoctor(context, {});
  assert.equal(await pathExists(context.paths.inboxFile("models", message.id)), true);
  assert.equal(normal.issues[0].code, "ACKED_MESSAGE_NOT_ARCHIVED");
  const repaired = await runDoctor(context, { repair: true });
  assert.equal(repaired.ok, true);
  assert.equal(await pathExists(context.paths.archiveFile("models", message.id)), true);
  assert.equal(repaired.repairs[0].action, "archive_acknowledged_message");
});

test("doctor fails closed on a corrupt pre-existing repair audit", async t => {
  const { context, clock } = await fixtureFor(t);
  const corruptPath = context.paths.inboxFile("models", "broken");
  await mkdir(path.dirname(corruptPath), { recursive: true });
  await writeFile(corruptPath, "{not-json");
  const repaired = await runDoctor(context, { repair: true });
  const auditPath = repaired.repairs[0].audit_path;
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  await writeFile(auditPath, `${JSON.stringify({ ...audit, recorded_at: "invalid" })}\n`);
  clock.advance(1_000);
  await writeFile(corruptPath, "{not-json");
  const blocked = await runDoctor(context, { repair: true });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.repairs, []);
  assert.equal(await pathExists(corruptPath), true);
});

test("doctor protects unknown protocol versions from repair", async t => {
  const { context } = await fixtureFor(t);
  await writeFile(context.paths.protocol, `${JSON.stringify({
    schema_version: 1, protocol_version: 2, checkout_id: "c".repeat(64),
    checkout_root: path.dirname(context.paths.root),
    initialized_at: context.now().toISOString(),
  })}\n`);
  const before = await readFile(context.paths.protocol, "utf8");
  const report = await runDoctor(context, { repair: true });
  assert.equal(report.ok, false);
  assert.equal(report.issues[0].code, "UNKNOWN_PROTOCOL_VERSION");
  assert.equal(await readFile(context.paths.protocol, "utf8"), before);
});

test("doctor invokes stale claim-lock repair but preserves young locks", async t => {
  const { context } = await fixtureFor(t);
  const young = await seedClaimLock(context, 60_000);
  assert.equal((await runDoctor(context, { repair: true })).repairs.length, 0);
  assert.equal(await pathExists(young), true);
  await unlink(path.join(young, "owner.json"));
  await rmdir(young);
  const stale = await seedClaimLock(context);
  const report = await runDoctor(context, { repair: true });
  assert.equal(report.repairs.some(item => item.action === "repair_stale_claim_lock"), true);
  assert.equal(await pathExists(stale), false);
});

test("doctor reports a corrupt claim-lock owner instead of skipping it", async t => {
  const { context } = await fixtureFor(t);
  const directory = path.join(context.paths.locks, "claims.lock");
  await mkdir(directory);
  const ownerPath = path.join(directory, "owner.json");
  await writeFile(ownerPath, "{not-json");
  assert.equal(enforcementExit(await collectStatus(context), {}), EXIT.DATA);
  const report = await runDoctor(context, {});
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.code === "CORRUPT_JSON"
    && item.path === ownerPath), true);
  const repaired = await runDoctor(context, { repair: true });
  assert.equal(repaired.ok, false);
  assert.equal(repaired.issues[0].code, "CORRUPT_JSON");
  assert.equal(await pathExists(directory), true);
  assert.equal(await pathExists(ownerPath), true);
});

test("doctor repairs stale watcher ownership and never removes a replacement", async t => {
  const { context } = await fixtureFor(t);
  const active = path.join(context.paths.locks, "watcher-models.json");
  const ownerA = watcherOwner(context);
  await writeFile(active, `${JSON.stringify(ownerA)}\n`);
  const repaired = await runDoctor(context, { repair: true });
  const audit = path.join(context.paths.quarantine,
    `watcher-owner-stale-${ownerA.token}.json`);
  assert.equal(repaired.repairs.some(item => item.action === "repair_stale_watcher_owner"), true);
  assert.equal(await pathExists(active), false);
  assert.deepEqual(JSON.parse(await readFile(audit, "utf8")), ownerA);

  await writeFile(active, `${JSON.stringify(ownerA)}\n`);
  const ownerB = watcherOwner(context, { pid: 4242,
    token: "22222222-2222-4222-8222-222222222222",
    acquired_at: context.now().toISOString() });
  let raced = false;
  const racingContext = { ...context, linkWatcherOwner: async () => {
    if (!raced) {
      raced = true;
      await unlink(active);
      await writeFile(active, `${JSON.stringify(ownerB)}\n`);
    }
    const error = new Error("exists");
    error.code = "EEXIST";
    throw error;
  } };
  const raceReport = await runDoctor(racingContext, { repair: true });
  assert.equal(raceReport.repairs.some(item => item.action === "repair_stale_watcher_owner"), false);
  assert.deepEqual(JSON.parse(await readFile(active, "utf8")), ownerB);
});
