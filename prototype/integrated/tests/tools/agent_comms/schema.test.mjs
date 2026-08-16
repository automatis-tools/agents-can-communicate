import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import {
  validateAcknowledgement,
  validateAgentId,
  validateAttachment,
  validateClaim,
  validateHandoff,
  validateLock,
  validateMessage,
  validatePresence,
  validateProtocol,
  validateRegistry,
  validateRepoPath,
  validateSeenReceipt,
} from "../../../tools/agents/lib/schema.mjs";

const NOW = "2026-08-14T18:30:12.123Z";
const GIT_SHA = "a".repeat(40);
const SHA256 = "b".repeat(64);

function validAttachment(overrides = {}) {
  return {
    path: "game/presentation/tank.gd",
    sha256: SHA256,
    size: 42,
    ephemeral: false,
    ...overrides,
  };
}

function validMessage(overrides = {}) {
  return {
    schema_version: 1,
    id: "20260814T183012.123Z-visual-550e8400-e29b-41d4-a716-446655440000",
    from: "visual",
    to: "models",
    type: "contract_request",
    severity: "action",
    subject: "Material slots required",
    body: "Provide stable surface names.",
    task: "M2.7",
    reply_to: null,
    requires_ack: true,
    created_at: NOW,
    sender_head: GIT_SHA,
    attachments: [],
    ...overrides,
  };
}

function validHandoff(overrides = {}) {
  return {
    schema_version: 1,
    id: "handoff-visual-models-1",
    from: "visual",
    to: "models",
    task: "M2.7",
    result: "Stable material slots added.",
    branch: "m2/visual",
    commit: GIT_SHA,
    base: "c".repeat(40),
    changed_paths: ["game/presentation/tank.gd"],
    verification: [{ command: "node --test", exitCode: 0, summary: "pass" }],
    contracts: { added: [], changed: ["tank-registration-v1"], consumed: [] },
    follow_up: ["models"],
    artifacts: [validAttachment({ commit: GIT_SHA })],
    limitations: [],
    uncommitted: false,
    ready_to_merge: true,
    state: "READY",
    created_at: NOW,
    ...overrides,
  };
}

function expectDataError(callback) {
  assert.throws(callback, error => error.exitCode === EXIT.DATA);
}

test("agent ids enforce the version-one lexical contract", () => {
  for (const value of ["a1", "visual", "models-m2_7", `a${"b".repeat(31)}`]) {
    assert.equal(validateAgentId(value), value);
  }
  for (const value of ["a", "Visual", "-visual", "visual.dot", `a${"b".repeat(32)}`, 7, null]) {
    expectDataError(() => validateAgentId(value));
  }
});

test("every message type and severity enum is accepted", () => {
  for (const type of [
    "status",
    "question",
    "contract_request",
    "contract_response",
    "blocker",
    "handoff",
    "broadcast",
  ]) {
    assert.equal(validateMessage(validMessage({ type })).type, type);
  }
  for (const severity of ["info", "action", "blocker"]) {
    assert.equal(validateMessage(validMessage({ severity })).severity, severity);
  }
  expectDataError(() => validateMessage(validMessage({ type: "request" })));
  expectDataError(() => validateMessage(validMessage({ severity: "warning" })));
});

test("unknown message versions fail loudly", () => {
  expectDataError(() => validateMessage(validMessage({ schema_version: 2 })));
});

test("messages reject absent required fields and wrong scalar or array types", () => {
  for (const field of Object.keys(validMessage())) {
    const message = validMessage();
    delete message[field];
    expectDataError(() => validateMessage(message));
  }
  for (const [field, value] of [
    ["id", 1],
    ["from", []],
    ["requires_ack", "true"],
    ["created_at", 1],
    ["reply_to", false],
    ["attachments", {}],
  ]) {
    expectDataError(() => validateMessage(validMessage({ [field]: value })));
  }
});

test("protocol-owned records reject unknown keys", () => {
  expectDataError(() => validateMessage(validMessage({ require_ack: true })));
  expectDataError(() => validateProtocol({
    schema_version: 1,
    protocol_version: 1,
    checkout_id: SHA256,
    checkout_root: "/checkout",
    initialized_at: NOW,
    typo: true,
  }));
});

test("attachments accept only normalized allowed relative paths", () => {
  for (const attachment of [
    validAttachment(),
    validAttachment({ path: ".agents/artifacts/render.png", ephemeral: true }),
  ]) {
    assert.equal(validateAttachment(attachment), attachment);
  }
  for (const invalidPath of [
    "/tmp/render.png",
    "../render.png",
    "game/../render.png",
    "game//render.png",
    "game\\render.png",
    ".",
  ]) {
    expectDataError(() => validateAttachment(validAttachment({ path: invalidPath })));
  }
  expectDataError(() => validateAttachment(validAttachment({
    path: "build/render.png",
    ephemeral: true,
  })));
});

test("repository paths reject the exact parent-directory escape", () => {
  expectDataError(() => validateRepoPath(".."));
});

test("attachments reject invalid checksums, sizes, and commit combinations", () => {
  for (const sha256 of ["abc", "A".repeat(64), 64]) {
    expectDataError(() => validateAttachment(validAttachment({ sha256 })));
  }
  for (const size of [-1, 1.5, "42"]) {
    expectDataError(() => validateAttachment(validAttachment({ size })));
  }
  expectDataError(() => validateAttachment(validAttachment({ ephemeral: "false" })));
  expectDataError(() => validateAttachment(validAttachment({
    path: ".agents/artifacts/render.png",
    ephemeral: true,
    commit: GIT_SHA,
  })));
});

test("identity and lifecycle records validate without cloning", () => {
  const protocol = {
    schema_version: 1,
    protocol_version: 1,
    checkout_id: SHA256,
    checkout_root: "/checkout",
    initialized_at: NOW,
  };
  const registry = {
    schema_version: 1,
    agent_id: "visual",
    role: "visual",
    task: "M2.7",
    worktree: "/checkout/.gitworktrees/visual",
    branch: "m2/visual",
    head: GIT_SHA,
    ownership: ["game/presentation", "contract:tank-registration-v1"],
    client: "codex",
    status: "open",
    registered_at: NOW,
    updated_at: NOW,
  };
  const presence = {
    schema_version: 1,
    agent_id: "visual",
    pid: 1234,
    status: "online",
    heartbeat_at: NOW,
  };
  assert.equal(validateProtocol(protocol), protocol);
  assert.equal(validateRegistry(registry), registry);
  assert.equal(validatePresence(presence), presence);
  expectDataError(() => validateRegistry({ ...registry, ownership: "game/presentation" }));
  expectDataError(() => validatePresence({ ...presence, pid: "1234" }));
});

test("handoffs require at least one verification record", () => {
  expectDataError(() => validateHandoff(validHandoff({ verification: [] })));
});

test("handoff readiness matches its state and verification results", () => {
  const failedVerification = [{ command: "node --test", exitCode: 1, summary: "failed" }];
  expectDataError(() => validateHandoff(validHandoff({ verification: failedVerification })));
  expectDataError(() => validateHandoff(validHandoff({ state: "NOT_READY" })));
  expectDataError(() => validateHandoff(validHandoff({
    ready_to_merge: false,
    state: "READY",
  })));

  const failedNotReady = validHandoff({
    verification: failedVerification,
    ready_to_merge: false,
    state: "NOT_READY",
  });
  assert.equal(validateHandoff(failedNotReady), failedNotReady);

  const uncommitted = validHandoff({
    commit: null,
    uncommitted: true,
    ready_to_merge: false,
    state: "UNCOMMITTED",
  });
  assert.equal(validateHandoff(uncommitted), uncommitted);
  expectDataError(() => validateHandoff({ ...uncommitted, ready_to_merge: true }));
  expectDataError(() => validateHandoff({ ...uncommitted, state: "NOT_READY" }));
});

test("receipt, claim, handoff, and lock records are strict", () => {
  const seen = {
    schema_version: 1,
    message_id: validMessage().id,
    recipient: "models",
    seen_at: NOW,
  };
  const acknowledgement = {
    schema_version: 1,
    message_id: validMessage().id,
    recipient: "models",
    acknowledged_at: NOW,
  };
  const claim = {
    schema_version: 1,
    agent_id: "visual",
    task: "M2.7",
    scope: "game/presentation",
    reason: "camera integration",
    created_at: NOW,
    updated_at: NOW,
    expires_at: NOW,
  };
  const handoff = validHandoff();
  const lock = {
    schema_version: 1,
    owner_agent: "visual",
    pid: 1234,
    acquired_at: NOW,
  };

  assert.equal(validateSeenReceipt(seen), seen);
  assert.equal(validateAcknowledgement(acknowledgement), acknowledgement);
  assert.equal(validateClaim(claim), claim);
  assert.equal(validateHandoff(handoff), handoff);
  assert.equal(validateLock(lock), lock);
  for (const [validate, record] of [
    [validateSeenReceipt, seen],
    [validateAcknowledgement, acknowledgement],
    [validateClaim, claim],
    [validateHandoff, handoff],
    [validateLock, lock],
  ]) {
    expectDataError(() => validate({ ...record, unknown: true }));
  }
});
