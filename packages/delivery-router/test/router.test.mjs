import assert from "node:assert/strict";
import test from "node:test";

import { defineAdapter } from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";

import { createDeliveryRouter } from "../src/router.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

// Kept cohesive above 300 lines because every case drives the same real core
// service and binding lifecycle; splitting would duplicate the delivery state
// fixture and obscure the policy, transport, and receipt transition matrix.

const NOW = "2026-09-01T20:00:00.000Z";
const WORKSPACE = "workspace_router";
const PLATFORM = `${process.platform}-${process.arch}`;

function certifiedAdapter(offerMessage = async ({ binding }) => ({
  accepted: true, transport: "codex-app-server", clientVersion: binding.clientVersion,
})) {
  return {
    id: "fixture_adapter",
    client: { command: "fixture-client" },
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [{ result: "pass", client: "fixture-client",
      version: "1.2.3", platform: PLATFORM, capability: "delivery.livePush" }] },
    nativeDelivery: { minimumByPlatform: { [PLATFORM]: "1.2.3" },
      anchors: [{ platform: PLATFORM, version: "1.2.3", protocolContract: "fixture-native-v1" }],
      knownBad: [], activationKinds: ["shell-bootstrap"] },
    offerMessage,
  };
}

// A native-delivery declaration that names no capture at all. defineAdapter
// rejects this shape outright, so no shipped adapter can carry it; it exists
// here only to reach evaluateVersionContract's defensive path.
const uncapturedAdapter = offerMessage => {
  const adapter = certifiedAdapter(offerMessage);
  return { ...adapter, nativeDelivery: { policySource: "installation-record" } };
};

// The ordinary shape of every shipped adapter: one captured platform and
// nothing said about any other. CAPTURED is where the contract speaks;
// UNCAPTURED is a real platform it is simply silent about - what darwin-arm64
// and linux-x64 are to `claude_code` and `codex` today.
const CAPTURED = "darwin-arm64";
const UNCAPTURED = "linux-x64";
const MINIMUM = "1.2.3";
const DENIED = "1.2.9";
const PRERELEASE = "1.3.0-rc.1";

const capture = version => ({ result: "pass", client: "fixture-client", version,
  platform: CAPTURED, capability: "delivery.livePush", observedAt: "2026-09-01",
  fixture: "fixtures/live-push.json", provenance: "fixtures/provenance.json",
  provenanceId: "fixture-capture", idleBehavior: "delivers while idle",
  busyBehavior: "queues while busy", authorityLevel: "observed", limitations: [] });

const answers = async () => ({ ok: true, changes: [], diagnostics: [] });

// Built through defineAdapter so that "a complete, valid contract" is proved
// here rather than asserted: defineAdapter runs the declaration through
// validateNativeDeliveryContract, which rejects a missing minimum map, missing
// anchors, an anchor with no passing capture, or a minimum no anchor matches.
// What survives is exactly what a shipped adapter carries - and it captures one
// platform, because that is all any of them has captured.
const singlePlatformAdapter = offerMessage => defineAdapter({
  id: "fixture_adapter",
  displayName: "Fixture client",
  client: { command: "fixture-client" },
  capabilities: { delivery: { livePush: true } },
  certification: { evidence: [capture(MINIMUM)] },
  nativeDelivery: {
    minimumByPlatform: { [CAPTURED]: MINIMUM },
    anchors: [{ platform: CAPTURED, version: MINIMUM, protocolContract: "fixture-native-v1" }],
    knownBad: [{ version: DENIED, reasonCode: "known_bad_version" }],
    activationKinds: ["shell-bootstrap"],
  },
  detect: answers, install: answers, uninstall: answers, doctor: answers,
  normalizeHook: answers, renderContext: answers,
  probeNativeDelivery: answers, planNativeActivation: answers, bindNativeSession: answers,
  offerMessage,
});

const reports = version => async () => ({ accepted: true, transport: "codex-app-server",
  clientVersion: version });

async function fixture({ adapter = certifiedAdapter(), secondRecipientSession = false,
  omitPlatform = false, platform = PLATFORM, readLivePolicy } = {}) {
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const sender = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "sender", sessionId: "session_sender", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  const recipient = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "models", sessionId: "session_models", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  const sessions = [recipient];
  if (secondRecipientSession) sessions.push(await service.openSession({
    workspaceId: WORKSPACE, participantId: "models", sessionId: "session_models_two",
    harness: "fixture", heartbeatCadenceMs: 30_000 }));
  const router = createDeliveryRouter({ service, adapters: { fixture_adapter: adapter }, clock,
    ...(omitPlatform ? {} : { platform }), readLivePolicy });
  return { adapter, clock, router, sender, service, sessions, store };
}

const publish = (service, session, overrides = {}) => service.publishDeliveryBinding({
  sessionId: session.sessionId, generation: session.generation,
  adapterId: "fixture_adapter", clientVersion: "1.2.3",
  availableModes: ["livePush"], livePolicy: "actionable",
  opaqueEndpointRef: `endpoint:${session.sessionId}`,
  leaseUntil: "2026-09-01T20:01:00.000Z", ...overrides,
});

const content = (kind, overrides = {}) => ({
  kind,
  obligation: ["question", "request"].includes(kind) ? "reply"
    : kind === "handoff" ? "acknowledge" : "none",
  subject: `${kind} subject`, body: `${kind} body`,
  handoff: kind === "handoff" ? { status: "partial", completed: [], remaining: ["work"],
    blockers: [], verification: [] } : null,
  ...overrides,
});

async function send(service, sender, kind = "question", suffix = kind) {
  return service.sendMessage({ sessionId: sender.sessionId, generation: sender.generation,
    clientMessageId: `client_${suffix}`, toParticipantIds: ["models"],
    artifacts: [], inReplyTo: null, ...content(kind) });
}

async function receipt(store, messageId) {
  return (await store.snapshot(WORKSPACE, { kinds: ["receipt"] })).receipts
    .find(item => item.messageId === messageId);
}

const durable = errorCode => [{ recipientParticipantId: "models", outcome: "queued",
  transport: "durable", errorCode }];

const installationAdapter = offerMessage => {
  const adapter = certifiedAdapter(offerMessage);
  return { ...adapter, nativeDelivery: { ...adapter.nativeDelivery,
    policySource: "installation-record" } };
};

test("one eligible certified binding is offered and only then committed", async () => {
  const f = await fixture();
  await publish(f.service, f.sessions[0]);
  const message = await send(f.service, f.sender);

  assert.deepEqual(await f.router.offer(message), [{ recipientParticipantId: "models",
    outcome: "offered", transport: "codex-app-server" }]);
  assert.equal((await receipt(f.store, message.messageId)).state, "offered");
});

test("an adapter throw observes queued and cannot advance the receipt", async () => {
  let stateAtOffer;
  let f;
  const adapter = certifiedAdapter(async () => {
    stateAtOffer = (await receipt(f.store, f.message.messageId)).state;
    throw new Error("endpoint disappeared: secret detail");
  });
  f = await fixture({ adapter });
  await publish(f.service, f.sessions[0]);
  f.message = await send(f.service, f.sender);

  assert.deepEqual(await f.router.offer(f.message), durable("transport_error"));
  assert.equal(stateAtOffer, "queued");
  assert.equal((await receipt(f.store, f.message.messageId)).state, "queued");
  const events = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
  const failed = events.find(event => event.type === "message.offer_failed");
  assert.equal(failed.payload.safeErrorCode, "transport_error");
  assert.equal(failed.payload.targetSessionId, f.sessions[0].sessionId);
  assert.equal(failed.payload.targetGeneration, f.sessions[0].generation);
  assert.equal(JSON.stringify(failed).includes("secret detail"), false);
});

test("an adapter rejection records safe evidence without advancing the receipt", async () => {
  const adapter = certifiedAdapter(async () => ({ accepted: false,
    transport: "codex-app-server", clientVersion: "1.2.3",
    safeErrorCode: "recipient_busy", detail: "secret endpoint detail" }));
  const f = await fixture({ adapter });
  await publish(f.service, f.sessions[0]);
  const message = await send(f.service, f.sender, "request", "rejected");

  assert.deepEqual(await f.router.offer(message), durable("recipient_busy"));
  assert.equal((await receipt(f.store, message.messageId)).state, "queued");
  const events = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
  const failed = events.find(event => event.type === "message.offer_failed");
  assert.equal(failed.payload.safeErrorCode, "recipient_busy");
  assert.equal(failed.payload.targetSessionId, f.sessions[0].sessionId);
  assert.equal(failed.payload.targetGeneration, f.sessions[0].generation);
  assert.equal(JSON.stringify(failed).includes("secret endpoint detail"), false);
});

test("an unapproved portable transport cannot expose the endpoint on success", async () => {
  const secretEndpoint = "secretEndpoint42";
  const adapter = certifiedAdapter(async ({ binding }) => ({ accepted: true,
    transport: binding.opaqueEndpointRef, clientVersion: binding.clientVersion }));
  const f = await fixture({ adapter });
  await publish(f.service, f.sessions[0], { opaqueEndpointRef: secretEndpoint });
  const message = await send(f.service, f.sender, "question", "secret_success");

  assert.deepEqual(await f.router.offer(message), [{ recipientParticipantId: "models",
    outcome: "offered", transport: "live-adapter" }]);
  const events = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
  const succeeded = events.find(event => event.type === "message.offer_succeeded");
  assert.equal(succeeded.payload.transport, "live-adapter");
  assert.equal(JSON.stringify(succeeded).includes(secretEndpoint), false);
});

test("an approved transport name cannot alias the endpoint on rejection", async () => {
  const secretEndpoint = "codex-app-server";
  const adapter = certifiedAdapter(async ({ binding }) => ({ accepted: false,
    transport: binding.opaqueEndpointRef, clientVersion: binding.clientVersion,
    safeErrorCode: "recipient_busy" }));
  const f = await fixture({ adapter });
  await publish(f.service, f.sessions[0], { opaqueEndpointRef: secretEndpoint });
  const message = await send(f.service, f.sender, "request", "secret_rejection");

  assert.deepEqual(await f.router.offer(message), durable("recipient_busy"));
  const events = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
  const failed = events.find(event => event.type === "message.offer_failed");
  assert.equal(failed.payload.transport, "live-adapter");
  assert.equal(JSON.stringify(failed).includes(secretEndpoint), false);
});

test("record-success failure cannot persist an endpoint-shaped transport", async () => {
  const secretEndpoint = "claude-channel";
  let f;
  const adapter = certifiedAdapter(async ({ binding }) => {
    await f.service.closeSession({ sessionId: f.sessions[0].sessionId,
      generation: f.sessions[0].generation });
    return { accepted: true, transport: binding.opaqueEndpointRef,
      clientVersion: binding.clientVersion };
  });
  f = await fixture({ adapter });
  await publish(f.service, f.sessions[0], { opaqueEndpointRef: secretEndpoint });
  const message = await send(f.service, f.sender, "question", "secret_record_failure");

  assert.deepEqual(await f.router.offer(message), durable("transport_error"));
  const events = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
  const failed = events.find(event => event.type === "message.offer_failed");
  assert.equal(failed.payload.transport, "live-adapter");
  assert.equal(JSON.stringify(failed).includes(secretEndpoint), false);
});

test("multiple eligible current sessions are ambiguous and durable-only", async () => {
  const f = await fixture({ secondRecipientSession: true });
  for (const session of f.sessions) await publish(f.service, session);
  const message = await send(f.service, f.sender);

  assert.deepEqual(await f.router.offer(message), durable("ambiguous_recipient_sessions"));
  assert.equal((await receipt(f.store, message.messageId)).state, "queued");
});

test("multiple current recipient sessions are ambiguous before binding eligibility",
  async () => {
    let offers = 0;
    const adapter = certifiedAdapter(async ({ binding }) => {
      offers += 1;
      return { accepted: true, transport: "codex-app-server",
        clientVersion: binding.clientVersion };
    });
    const f = await fixture({ adapter, secondRecipientSession: true });
    await publish(f.service, f.sessions[0]);
    const message = await send(f.service, f.sender, "question", "one_of_two_bound");

    assert.deepEqual(await f.router.offer(message), durable("ambiguous_recipient_sessions"));
    assert.equal(offers, 0, "the router offered before resolving session ambiguity");
    assert.equal((await receipt(f.store, message.messageId)).state, "queued");
  });

test("closed extra sessions do not create false ambiguity", async () => {
  const f = await fixture({ secondRecipientSession: true });
  await f.service.closeSession({ sessionId: f.sessions[1].sessionId,
    generation: f.sessions[1].generation });
  await publish(f.service, f.sessions[0]);
  const message = await send(f.service, f.sender, "question", "closed_extra");

  assert.equal((await f.router.offer(message))[0].outcome, "offered");
});

test("a stale extra session still makes live delivery ambiguous", async () => {
  const f = await fixture({ secondRecipientSession: true });
  await publish(f.service, f.sessions[0], { leaseUntil: "2026-09-01T20:03:00.000Z" });
  f.clock.advance(90_001);
  await f.service.heartbeatSession({ sessionId: f.sender.sessionId,
    generation: f.sender.generation });
  await f.service.heartbeatSession({ sessionId: f.sessions[0].sessionId,
    generation: f.sessions[0].generation });
  const message = await send(f.service, f.sender, "question", "stale_extra");

  assert.deepEqual(await f.router.offer(message), durable("ambiguous_recipient_sessions"));
});

test("an offline extra session does not create false ambiguity", async () => {
  const f = await fixture({ secondRecipientSession: true });
  await publish(f.service, f.sessions[0], { leaseUntil: "2026-09-01T21:00:00.000Z" });
  f.clock.advance(30 * 60_000 + 1);
  await f.service.heartbeatSession({ sessionId: f.sender.sessionId,
    generation: f.sender.generation });
  await f.service.heartbeatSession({ sessionId: f.sessions[0].sessionId,
    generation: f.sessions[0].generation });
  const message = await send(f.service, f.sender, "question", "offline_extra");

  assert.equal((await f.router.offer(message))[0].outcome, "offered");
});

test("lease expiry and generation replacement remove a binding from eligibility", async () => {
  const f = await fixture();
  await publish(f.service, f.sessions[0]);
  const expired = await send(f.service, f.sender, "question", "expired");
  f.clock.advance(60_001);
  assert.deepEqual(await f.router.offer(expired), durable("recipient_unavailable"));

  const current = f.sessions[0];
  await f.service.closeSession({ sessionId: current.sessionId, generation: current.generation });
  await f.service.openSession({ workspaceId: WORKSPACE, participantId: "models",
    sessionId: current.sessionId, harness: "fixture", heartbeatCadenceMs: 30_000 });
  const replaced = await send(f.service, f.sender, "question", "replaced");
  assert.deepEqual(await f.router.offer(replaced), durable("recipient_unavailable"));
});

test("off, missing reachability, and live-incapable adapters stay queued for distinct reasons",
  async () => {
    const noContract = { ...certifiedAdapter(), nativeDelivery: undefined };
    const declaredOff = { ...certifiedAdapter(), capabilities: { delivery: { livePush: false } } };
    for (const [name, overrides, errorCode, adapter] of [
      ["off", { livePolicy: "off" }, "delivery_disabled", undefined],
      ["no-mode", { availableModes: ["nextTurn"] }, "recipient_unavailable", undefined],
      ["no-native-contract", {}, "unsupported_client_version", noContract],
      ["capability-off", {}, "unsupported_client_version", declaredOff],
      ["unknown-adapter", { adapterId: "other_adapter" }, "unsupported_client_version", undefined],
    ]) {
      const f = await fixture(adapter === undefined ? {} : { adapter });
      await publish(f.service, f.sessions[0], overrides);
      const message = await send(f.service, f.sender, "question", name);
      assert.deepEqual(await f.router.offer(message), durable(errorCode), name);
      assert.equal((await receipt(f.store, message.messageId)).state, "queued");
    }
  });

test("a newer binding version admitted by the handshake is offered without re-certification",
  async () => {
    const f = await fixture();
    await publish(f.service, f.sessions[0], { clientVersion: "9.9.9" });
    const message = await send(f.service, f.sender, "question", "newer");
    assert.equal((await f.router.offer(message))[0].outcome, "offered");
    assert.equal((await receipt(f.store, message.messageId)).state, "offered");
  });

test("an offer whose reported client version fails the captured contract stays queued", async () => {
  const belowMinimum = certifiedAdapter(async () => ({ accepted: true,
    transport: "codex-app-server", clientVersion: "1.2.2" }));
  const denylisted = { ...certifiedAdapter(async () => ({ accepted: true,
    transport: "codex-app-server", clientVersion: "1.2.5" })),
    nativeDelivery: { ...certifiedAdapter().nativeDelivery,
      knownBad: [{ version: "1.2.5", reasonCode: "known_bad_version" }] } };
  for (const [name, adapter] of [["below the captured minimum", belowMinimum],
    ["on the captured denylist", denylisted]]) {
    const f = await fixture({ adapter });
    await publish(f.service, f.sessions[0]);
    const message = await send(f.service, f.sender, "question", `drift_${name.replace(/\W+/g, "_")}`);
    assert.deepEqual(await f.router.offer(message), durable("unsupported_client_version"), name);
    assert.equal((await receipt(f.store, message.messageId)).state, "queued", name);
  }
});

test("an offer whose reported client version differs from the binding but still "
  + "satisfies the captured contract is offered", async () => {
  const f = await fixture({ adapter: certifiedAdapter(async () => ({ accepted: true,
    transport: "codex-app-server", clientVersion: "1.2.4" })) });
  await publish(f.service, f.sessions[0]);
  const message = await send(f.service, f.sender, "question", "drift_upgraded");
  assert.equal((await f.router.offer(message))[0].outcome, "offered");
  assert.equal((await receipt(f.store, message.messageId)).state, "offered");
});

// The contract is captured per platform, so a router handed no platform judged
// every offer against "no capture for undefined" and refused it. The fixture
// minimum is captured for the host platform, which is what the default
// resolves to. The answering version is above the minimum but different from
// the bound one, so only a real capture for the right platform admits it.
test("a router given no platform judges against the captured contract for the host it runs on",
  async () => {
    const f = await fixture({ omitPlatform: true,
      adapter: certifiedAdapter(async () => ({ accepted: true,
        transport: "codex-app-server", clientVersion: "1.2.4" })) });
    await publish(f.service, f.sessions[0]);
    const message = await send(f.service, f.sender, "question", "default_platform");
    assert.deepEqual(await f.router.offer(message), [{ recipientParticipantId: "models",
      outcome: "offered", transport: "codex-app-server" }]);
    assert.equal((await receipt(f.store, message.messageId)).state, "offered");
  });

// The real uncaptured case, and the reason CI refused every live offer on
// Linux: `claude_code` and `codex` capture darwin-arm64 and say nothing about
// linux-x64, so the contract returns platform_not_captured there. That is not
// the contract refusing a version - it is the contract having no minimum to
// judge one against - and it is the ordinary state of every shipped adapter on
// every host but one. With nothing captured, the offer keeps the rule this
// path had before the contract gate: the version that answered must be the one
// the binding recorded. The declaration here went through defineAdapter, so it
// is complete and valid by construction, not partial.
test("a contract silent about this platform admits the version the binding recorded",
  async () => {
    const f = await fixture({ platform: UNCAPTURED,
      adapter: singlePlatformAdapter(reports(MINIMUM)) });
    await publish(f.service, f.sessions[0], { clientVersion: MINIMUM });
    const message = await send(f.service, f.sender, "question", "uncaptured_match");
    assert.deepEqual(await f.router.offer(message), [{ recipientParticipantId: "models",
      outcome: "offered", transport: "codex-app-server" }]);
    assert.equal((await receipt(f.store, message.messageId)).state, "offered");
  });

// The other half of the same rule. Silence about the platform is not a licence
// to admit anything: without a capture the identity comparison is all the
// evidence there is, and a version the binding never recorded fails it. A
// fallback that simply admitted every uncaptured platform would pass the test
// above and fail this one.
test("a contract silent about this platform still refuses a version the binding never recorded",
  async () => {
    const f = await fixture({ platform: UNCAPTURED,
      adapter: singlePlatformAdapter(reports("1.2.4")) });
    await publish(f.service, f.sessions[0], { clientVersion: MINIMUM });
    const message = await send(f.service, f.sender, "question", "uncaptured_drift");
    assert.deepEqual(await f.router.offer(message), durable("unsupported_client_version"));
    assert.equal((await receipt(f.store, message.messageId)).state, "queued");
  });

// The merge guarded from the opposite direction. Every version here is the one
// the binding recorded, so the identity comparison would admit all of them -
// only a captured contract reading the version refuses. Extending the
// uncaptured fallback to these reason codes turns each case into an offer.
test("a captured contract refuses the version it judges even when the binding recorded it",
  async () => {
    for (const [name, version] of [["below the captured minimum", "1.2.2"],
      ["on the captured denylist", DENIED], ["not a stable version", PRERELEASE]]) {
      const f = await fixture({ platform: CAPTURED,
        adapter: singlePlatformAdapter(reports(version)) });
      await publish(f.service, f.sessions[0], { clientVersion: version });
      const message = await send(f.service, f.sender, "question", `judged_${version}`);
      assert.deepEqual(await f.router.offer(message), durable("unsupported_client_version"), name);
      assert.equal((await receipt(f.store, message.messageId)).state, "queued", name);
    }
  });

// An answer carrying no version at all. A binding's clientVersion is validated
// text, so this can never equal it and the grouping cannot change the outcome;
// what is pinned is that a missing version is refused rather than read as
// agreement with an absent value.
test("an answer with no client version is refused on a captured platform", async () => {
  const f = await fixture({ platform: CAPTURED,
    adapter: singlePlatformAdapter(async () => ({ accepted: true,
      transport: "codex-app-server" })) });
  await publish(f.service, f.sessions[0], { clientVersion: MINIMUM });
  const message = await send(f.service, f.sender, "question", "absent_version");
  assert.deepEqual(await f.router.offer(message), durable("unsupported_client_version"));
  assert.equal((await receipt(f.store, message.messageId)).state, "queued");
});

// Defence, not a reachable case: defineAdapter rejects a declaration this
// incomplete, so no shipped adapter reaches here. What is pinned is that the
// contract check answers it with a reason code rather than throwing out of the
// offer, where the failure would surface as a transport diagnostic pointing
// nowhere near the declaration that caused it - a throw is reported as
// transport_error, never as unsupported_client_version. A declaration with no
// minimum map has captured nothing for any platform, so it lands in the same
// group as a valid contract that is silent about this one.
test("an adapter whose declaration captured nothing answers without crashing the offer",
  async () => {
    for (const [name, answered, expected] of [
      ["a version the binding never recorded", "1.2.4", durable("unsupported_client_version")],
      ["the version the binding recorded", "1.2.3", [{ recipientParticipantId: "models",
        outcome: "offered", transport: "codex-app-server" }]],
    ]) {
      const f = await fixture({ adapter: uncapturedAdapter(reports(answered)),
        readLivePolicy: async () => "actionable" });
      await publish(f.service, f.sessions[0]);
      const message = await send(f.service, f.sender, "question", `uncaptured_${answered}`);
      assert.deepEqual(await f.router.offer(message), expected, name);
      assert.equal((await receipt(f.store, message.messageId)).state,
        expected[0].outcome, name);
    }
  });

const POLICY_MATRIX = [
  ["question", "offered", "offered"], ["request", "offered", "offered"],
  ["answer", "offered", "offered"], ["decision", "offered", "offered"],
  ["handoff", "offered", "offered"], ["note", "queued", "offered"],
];

async function sendKind(f, kind, suffix) {
  if (kind !== "answer") return send(f.service, f.sender, kind, suffix);
  const asked = await send(f.service, f.sender, "question", `${suffix}_root`);
  return f.service.sendMessage({ sessionId: f.sender.sessionId, generation: f.sender.generation,
    clientMessageId: `client_${suffix}`, toParticipantIds: ["models"], artifacts: [],
    inReplyTo: asked.messageId, ...content("answer") });
}

test("actionable offers every conversation-advancing kind and holds notes for the next turn",
  async () => {
    for (const [kind, underActionable] of POLICY_MATRIX) {
      const f = await fixture();
      await publish(f.service, f.sessions[0]);
      const message = await sendKind(f, kind, `actionable_${kind}`);
      const [outcome] = await f.router.offer(message);
      assert.equal(outcome.outcome, underActionable, kind);
      if (underActionable === "queued") assert.equal(outcome.errorCode, "delivery_disabled");
      assert.equal((await receipt(f.store, message.messageId)).state, underActionable, kind);
  }
});

test("current recorded policy narrows and expands an existing binding", async () => {
  // The final row broadens an actionable binding to all. Its note must reach
  // offer now, without waiting for another recipient hook to rewrite the
  // binding; filtering on the binding snapshot would defeat the current read.
  for (const [policy, bindingPolicy, kind, expected] of [
    ["off", "all", "question", "queued"],
    ["actionable", "all", "note", "queued"],
    ["actionable", "all", "question", "offered"],
    ["actionable", "all", "request", "offered"],
    ["actionable", "all", "answer", "offered"],
    ["all", "actionable", "note", "offered"],
  ]) {
    let offers = 0;
    const adapter = installationAdapter(async ({ binding }) => {
      offers += 1;
      assert.equal(binding.livePolicy, policy);
      return { accepted: true, transport: "codex-app-server",
        clientVersion: binding.clientVersion };
    });
    const f = await fixture({ adapter, readLivePolicy: async () => policy });
    await publish(f.service, f.sessions[0], { livePolicy: bindingPolicy });
    const message = await sendKind(f, kind, `recorded_${policy}_${kind}`);

    const [outcome] = await f.router.offer(message);

    assert.equal(outcome.outcome, expected, `${policy} ${kind}`);
    assert.equal(offers, expected === "offered" ? 1 : 0, `${policy} ${kind}`);
    assert.equal((await receipt(f.store, message.messageId)).state, expected);
  }
});

test("policy is read again immediately before offer", async () => {
  const reads = [];
  let offers = 0;
  const f = await fixture({ adapter: installationAdapter(async () => {
    offers += 1;
    return { accepted: true, transport: "codex-app-server", clientVersion: "1.2.3" };
  }), readLivePolicy: async () => {
    const policy = reads.length === 0 ? "all" : "off";
    reads.push(policy);
    return policy;
  } });
  await publish(f.service, f.sessions[0], { livePolicy: "all" });
  const message = await send(f.service, f.sender, "question", "policy_race");

  assert.deepEqual(await f.router.offer(message), durable("delivery_disabled"));
  assert.deepEqual(reads, ["all", "off"]);
  assert.equal(offers, 0);
  assert.equal((await receipt(f.store, message.messageId)).state, "queued");
});

test("missing or failed recorded-policy readers disable live delivery", async () => {
  for (const [name, readLivePolicy] of [
    ["missing", undefined],
    ["failed", async () => { throw new Error("corrupt installation record"); }],
  ]) {
    let offers = 0;
    const f = await fixture({ adapter: installationAdapter(async () => { offers += 1; }),
      readLivePolicy });
    await publish(f.service, f.sessions[0], { livePolicy: "all" });
    const message = await send(f.service, f.sender, "question", `reader_${name}`);

    assert.deepEqual(await f.router.offer(message), durable("delivery_disabled"), name);
    assert.equal(offers, 0, name);
    assert.equal((await receipt(f.store, message.messageId)).state, "queued", name);
  }
});

test("off holds every kind and all offers every addressed kind", async () => {
  for (const [kind, , underAll] of POLICY_MATRIX) {
    const off = await fixture();
    await publish(off.service, off.sessions[0], { livePolicy: "off" });
    assert.deepEqual(await off.router.offer(await sendKind(off, kind, `off_${kind}`)),
      durable("delivery_disabled"), kind);
    const all = await fixture();
    await publish(all.service, all.sessions[0], { livePolicy: "all" });
    assert.equal((await all.router.offer(await sendKind(all, kind, `all_${kind}`)))[0].outcome,
      underAll, kind);
  }
});

test("all permits every addressed kind while room messages are never live-pushed", async () => {
  const f = await fixture();
  await publish(f.service, f.sessions[0], { livePolicy: "all" });
  for (const kind of ["note", "decision"]) {
    const message = await send(f.service, f.sender, kind, `all_${kind}`);
    assert.equal((await f.router.offer(message))[0].outcome, "offered", kind);
  }
  const room = await f.service.sendMessage({ sessionId: f.sender.sessionId,
    generation: f.sender.generation, clientMessageId: "client_room",
    toParticipantIds: [], artifacts: [], inReplyTo: null, ...content("note") });
  assert.deepEqual(await f.router.offer(room), []);
});
