import { CONTRACT_ID, FINGERPRINT, HANDSHAKE_KEYS, HANDSHAKE_OPTIONAL_KEYS, KNOWN_BAD_REASON,
  NATIVE_BINDING_MODES, PLANNABLE_ACTIVATION_KINDS, PROBE_KEYS, TIMESTAMP, assertModes,
  assertReasonCode, closed, compareStableVersions, deepFreeze, isLaunchOption, isPlainObject, isText,
  parseStableVersion, usage } from "./native-vocabulary.mjs";
import { compareVersionOrder, versionOrder } from "./certification.mjs";

// The native-delivery compatibility contract: a minimum that is a real passing
// capture, one or more anchors naming the captured protocol, an explicit
// denylist, and the activation kinds an adapter may ask the installer for.
// There is deliberately no maximum: a newer stable client is admitted only
// when a current read-only probe and a per-session handshake confirm the same
// protocol contract. There is no platform either: a capture records where a
// behaviour was observed, the minimum it establishes applies everywhere, and
// the probe and handshake decide on the machine in hand (see
// docs/design/2026-09-26-native-delivery-across-platforms.md). Certification
// evidence still governs every other capability; this rule is used for native
// live delivery alone.

export { NATIVE_ACTIVATION_KINDS, NATIVE_BINDING_MODES, NATIVE_REASON_CODES,
  PLANNABLE_ACTIVATION_KINDS, compareStableVersions, isLaunchOption, parseStableVersion }
  from "./native-vocabulary.mjs";
export { validateNativeActivationPlan } from "./native-activation.mjs";

const orderedModes = modes => NATIVE_BINDING_MODES.filter(mode => modes.includes(mode));

export function validateNativeDeliveryContract(value, { certification, client, clients = [client] }) {
  // Consent to live delivery is what `acc install` recorded. Up to 0.7.x a
  // Claude shell shim could export it instead ("bootstrap-environment"); the
  // shim is gone, and the installation record is the one source left.
  const policySource = Object.hasOwn(value ?? {}, "policySource")
    ? value.policySource : "installation-record";
  // What a successful offer put in front of the model. "message" carries the
  // body, so the router records the receipt as offered. "wake" carries only a
  // notice that makes the client run a turn; the body reaches the model through
  // the next-turn hook, which records the offer itself once its stdout carried
  // the body. Recording a wake as offered would hide the body from that hook.
  const offerKind = Object.hasOwn(value ?? {}, "offerKind") ? value.offerKind : "message";
  // The per-platform shape 0.8.0 and earlier declared. Refused by name: an
  // adapter built against that SDK should learn what replaced it, not fail on
  // a generic unknown field.
  if (Object.hasOwn(value ?? {}, "minimumByPlatform")) {
    usage("nativeDelivery.minimumByPlatform is no longer declared; a capture's minimum applies on "
      + "every platform, so declare nativeDelivery.minimum instead "
      + "(docs/design/2026-09-26-native-delivery-across-platforms.md)");
  }
  closed({ ...value, policySource, offerKind },
    ["minimum", "anchors", "knownBad", "activationKinds", "policySource", "offerKind"],
    "nativeDelivery");
  if (policySource !== "installation-record") {
    usage("nativeDelivery.policySource must be installation-record");
  }
  if (!["message", "wake"].includes(offerKind)) {
    usage("nativeDelivery.offerKind must be message or wake");
  }
  const minimum = value.minimum;
  if (parseStableVersion(minimum) === null) {
    usage("nativeDelivery.minimum must be a stable version");
  }
  if (!Array.isArray(value.anchors) || value.anchors.length === 0) {
    usage("nativeDelivery.anchors must name at least one passing capture");
  }
  const anchors = value.anchors.map((anchor, index) => {
    if (Object.hasOwn(anchor ?? {}, "platform")) {
      usage(`nativeDelivery anchor ${index} names a platform; the platform a capture was taken on `
        + "is recorded by its evidence, and the anchor names the version alone "
        + "(docs/design/2026-09-26-native-delivery-across-platforms.md)");
    }
    closed(anchor, ["version", "protocolContract"], "nativeDelivery anchor", ["client"]);
    if (parseStableVersion(anchor.version) === null) {
      usage(`nativeDelivery anchor ${index} version must be a stable version`);
    }
    // An anchor may belong to another product the adapter serves (see
    // client.variants). Its versions count on that product's own line, so the
    // primary minimum says nothing about them.
    const owner = Object.hasOwn(anchor, "client") ? anchor.client : client;
    if (!clients.includes(owner)) {
      usage(`nativeDelivery anchor ${anchor.version} names client ${owner}, which the adapter `
        + "does not declare", { anchor });
    }
    if (owner === client && compareStableVersions(anchor.version, minimum) < 0) {
      usage(`nativeDelivery anchor ${index} version ${anchor.version} is below the minimum ${minimum}: `
        + "the minimum must be the first passing capture");
    }
    if (!isText(anchor.protocolContract) || !CONTRACT_ID.test(anchor.protocolContract)) {
      usage(`nativeDelivery anchor ${index} protocolContract must be a closed identifier`);
    }
    // Where the capture was taken is provenance the evidence row keeps; the
    // anchor is proven by a passing capture of this version on any platform.
    const proven = (certification?.evidence ?? []).some(item => item.result === "pass"
      && item.capability === "delivery.livePush" && item.client === owner
      && item.version === anchor.version);
    if (!proven) {
      usage(`nativeDelivery anchor ${anchor.version} has no passing delivery.livePush certification`,
        { anchor });
    }
    return { ...anchor };
  });
  const owners = new Map();
  for (const anchor of anchors) {
    const owner = anchor.client ?? client;
    const previous = owners.get(anchor.protocolContract);
    if (previous !== undefined && previous !== owner) {
      usage(`nativeDelivery protocol ${anchor.protocolContract} is anchored for both ${previous} `
        + `and ${owner}`, { protocolContract: anchor.protocolContract });
    }
    owners.set(anchor.protocolContract, owner);
  }
  if (!anchors.some(anchor => (anchor.client ?? client) === client
    && compareStableVersions(anchor.version, minimum) === 0)) {
    usage(`nativeDelivery minimum ${minimum} must be the first passing capture: no anchor matches it`);
  }
  if (!Array.isArray(value.knownBad)) usage("nativeDelivery.knownBad must be an array");
  const knownBad = value.knownBad.map(entry => {
    const exact = isPlainObject(entry) && Object.hasOwn(entry, "version");
    closed(entry, exact ? ["version", "reasonCode"] : ["from", "to", "reasonCode"],
      "nativeDelivery.knownBad entry");
    for (const key of exact ? ["version"] : ["from", "to"]) {
      if (parseStableVersion(entry[key]) === null) {
        usage(`nativeDelivery.knownBad ${key} must be a stable version`);
      }
    }
    if (!exact && compareStableVersions(entry.from, entry.to) > 0) {
      usage("nativeDelivery.knownBad interval from must not exceed to");
    }
    if (entry.reasonCode !== KNOWN_BAD_REASON) {
      usage(`nativeDelivery.knownBad reasonCode must be ${KNOWN_BAD_REASON}`);
    }
    return { ...entry };
  });
  const kinds = value.activationKinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || new Set(kinds).size !== kinds.length
    || kinds.some(kind => !PLANNABLE_ACTIVATION_KINDS.includes(kind))) {
    usage(`nativeDelivery.activationKinds must be unique entries of ${PLANNABLE_ACTIVATION_KINDS.join(", ")}`);
  }
  return deepFreeze({ minimum, anchors, knownBad, activationKinds: [...kinds], policySource,
    offerKind });
}

// `order` is the client's release triple; the denylist names stable versions,
// so a prerelease of a denylisted release is on it too.
function knownBadHit(contract, order) {
  const hit = (left, right) => compareVersionOrder(left, versionOrder(right));
  return contract.knownBad.some(entry => (Object.hasOwn(entry, "version")
    ? hit(order, entry.version) === 0
    : hit(order, entry.from) >= 0 && hit(order, entry.to) <= 0));
}

// Judges one reported client version against an adapter's captured
// native-delivery contract: is the version at or above the captured minimum,
// and is it not on the denylist. Returns
// { reasonCode, minimumVersion, protocolContract }; reasonCode is null when
// the version satisfies the contract, otherwise one of
// "native_delivery_unsupported", "version_unavailable", "below_minimum_version",
// or "known_bad_version". The platform the caller runs on plays no part: the
// minimum was captured somewhere and applies everywhere. A prerelease is
// judged by its release triple, as hook capabilities are: what admits it is
// the protocol contract the probe or handshake reports, not the suffix.
//
// This is the static half of the rule only: it never contacts the client, so
// passing here proves nothing about whether a live probe or handshake
// actually confirms the protocol or delivery modes. A caller that needs that
// layers a probe or handshake check on top (see evaluateNativeEligibility,
// validateNativeHandshake below, and the delivery router's own offer check,
// which uses this function alone because a response already carries no probe
// or handshake shape to check further).
export function evaluateVersionContract(adapter, { clientVersion, protocolContract } = {}) {
  const contract = adapter?.nativeDelivery;
  const unsupported = { reasonCode: "native_delivery_unsupported", minimumVersion: null,
    protocolContract: null };
  // `== null` rather than `=== undefined`: a null declaration is as much "no
  // contract" as a missing one, and reading `contract.minimum` off it threw
  // the very TypeError the guard below exists to prevent. defineAdapter cannot
  // produce that shape; a hand-built registry entry can.
  if (contract == null) return unsupported;
  // validateNativeDeliveryContract guarantees a minimum and a matching anchor,
  // but this function is also handed adapter objects that never went through
  // it. A declaration missing either half has captured nothing, which is a
  // closed answer - not a TypeError raised deep inside a delivery offer, far
  // from the declaration that caused it. Every other entry point below
  // already answers malformed input this way.
  const minimumVersion = isText(contract.minimum) ? contract.minimum : null;
  if (minimumVersion === null) return unsupported;
  const anchors = Array.isArray(contract.anchors) ? contract.anchors : [];
  const primary = adapter.client?.certificationName ?? adapter.client?.command;
  const anchor = anchors.find(item => item?.version === minimumVersion
    && (!isText(item?.client) || item.client === primary));
  if (anchor === undefined) return unsupported;
  // Another product's protocol has its own floor - the first capture that
  // anchored it - and the denylist, which names the primary product's
  // versions, does not reach it. Asked about no protocol, or the primary one,
  // the rule is the primary minimum as it always was.
  if (isText(protocolContract) && protocolContract !== anchor.protocolContract) {
    return protocolFloor(anchors, protocolContract, clientVersion);
  }
  const facts = { minimumVersion, protocolContract: anchor.protocolContract };
  const order = versionOrder(clientVersion);
  if (order === null) return { ...facts, reasonCode: "version_unavailable" };
  if (compareVersionOrder(order, versionOrder(minimumVersion)) < 0) {
    return { ...facts, reasonCode: "below_minimum_version" };
  }
  if (knownBadHit(contract, order)) return { ...facts, reasonCode: "known_bad_version" };
  return { ...facts, reasonCode: null };
}

function protocolFloor(anchors, protocolContract, clientVersion) {
  const own = anchors.filter(item => item?.protocolContract === protocolContract
    && isText(item?.version));
  if (own.length === 0) {
    return { reasonCode: "protocol_mismatch", minimumVersion: null, protocolContract };
  }
  const minimumVersion = own.map(item => item.version)
    .reduce((first, version) => (compareStableVersions(version, first) < 0 ? version : first));
  const facts = { minimumVersion, protocolContract };
  const order = versionOrder(clientVersion);
  if (order === null) return { ...facts, reasonCode: "version_unavailable" };
  if (compareVersionOrder(order, versionOrder(minimumVersion)) < 0) {
    return { ...facts, reasonCode: "below_minimum_version" };
  }
  return { ...facts, reasonCode: null };
}

// The protocol a probe or handshake reports, when it is one an anchor names:
// that protocol's own floor judges it. Any other value is left to the primary
// rule, so it still ends as the protocol_mismatch it always was.
function reportedProtocol(adapter, reported) {
  return isText(reported) && (adapter?.nativeDelivery?.anchors ?? [])
    .some(item => item?.protocolContract === reported) ? reported : undefined;
}

function validateNativeProbe(probe) {
  closed(probe, PROBE_KEYS, "native probe");
  if (typeof probe.supported !== "boolean") usage("native probe supported must be a boolean");
  if (probe.clientVersion !== null && !isText(probe.clientVersion)) {
    usage("native probe clientVersion must be a string or null");
  }
  if (probe.protocolContract !== null
    && (!isText(probe.protocolContract) || !CONTRACT_ID.test(probe.protocolContract))) {
    usage("native probe protocolContract must be a closed identifier or null");
  }
  if (probe.executableFingerprint !== null
    && (!isText(probe.executableFingerprint) || !FINGERPRINT.test(probe.executableFingerprint))) {
    usage("native probe executableFingerprint must be sha256:<64 hex> or null");
  }
  assertModes(probe.modes, "native probe");
  assertReasonCode(probe.reasonCode, "native probe");
  return probe;
}

export function evaluateNativeEligibility(adapter, { clientVersion, probe }) {
  // The probe names the process that will serve the delivery. Judging the
  // detected binary instead refuses a service that satisfies the contract.
  // Only the version is read here; the shape is validated where it always was,
  // so a malformed probe still returns a closed result rather than throwing.
  const serving = isText(probe?.clientVersion) ? probe.clientVersion : clientVersion;
  const rule = evaluateVersionContract(adapter, { clientVersion: serving,
    protocolContract: reportedProtocol(adapter, probe?.protocolContract) });
  const base = { eligible: false, reasonCode: null, minimumVersion: rule.minimumVersion,
    protocolContract: rule.protocolContract, modes: [] };
  const closedResult = reasonCode => deepFreeze({ ...base, reasonCode });
  if (rule.reasonCode !== null) return closedResult(rule.reasonCode);
  if (probe === null || probe === undefined) return closedResult("feature_probe_failed");
  const facts = validateNativeProbe(probe);
  if (facts.supported !== true) return closedResult(facts.reasonCode ?? "feature_probe_failed");
  if (facts.protocolContract !== rule.protocolContract) return closedResult("protocol_mismatch");
  const modes = orderedModes(facts.modes);
  if (!modes.includes("livePush")) return closedResult("feature_probe_failed");
  return deepFreeze({ eligible: true, reasonCode: null, minimumVersion: rule.minimumVersion,
    protocolContract: rule.protocolContract, modes });
}

function validateNativeHandshakeShape(handshake) {
  closed(handshake, HANDSHAKE_KEYS, "native handshake", HANDSHAKE_OPTIONAL_KEYS);
  if (typeof handshake.supported !== "boolean") usage("native handshake supported must be a boolean");
  if (handshake.clientVersion !== null && !isText(handshake.clientVersion)) {
    usage("native handshake clientVersion must be a string or null");
  }
  if (handshake.protocolContract !== null && (!isText(handshake.protocolContract)
    || !CONTRACT_ID.test(handshake.protocolContract))) {
    usage("native handshake protocolContract must be a closed identifier or null");
  }
  assertModes(handshake.modes, "native handshake");
  assertReasonCode(handshake.reasonCode, "native handshake");
  if (handshake.supported) {
    if (!isText(handshake.opaqueEndpointRef)) {
      usage("native handshake opaqueEndpointRef must be a non-empty opaque string");
    }
    if (!isText(handshake.leaseUntil) || !TIMESTAMP.test(handshake.leaseUntil)
      || Number.isNaN(Date.parse(handshake.leaseUntil))) {
      usage("native handshake leaseUntil must be a UTC timestamp");
    }
  } else if (handshake.opaqueEndpointRef !== null || handshake.leaseUntil !== null) {
    usage("an unsupported native handshake carries no endpoint or lease");
  }
  if (Object.hasOwn(handshake, "launchOption")) {
    if (handshake.supported) usage("only a refused native handshake names a launchOption");
    if (!isLaunchOption(handshake.launchOption)) {
      usage("native handshake launchOption must be a bare command-line option");
    }
  }
  return handshake;
}

// The per-session half: the same static rule again, then the adapter's live
// handshake facts. The launch-time executable fingerprint stays probe-only.
//
// An admitted verdict reports the version it admitted as `clientVersion`. That
// is the whole point of returning it: the caller publishes a binding, and the
// binding must record the version the admission actually rests on - the one
// that will serve - rather than the caller's own detected-CLI claim. 0.5.0
// judged the serving version here and left the caller publishing its claim, so
// the two records disagreed on every machine where a daemon had updated under
// its CLI, which is exactly the case the release exists to support. A refused
// verdict admits nothing and carries null.
export function validateNativeHandshake(adapter, { clientVersion, handshake }) {
  // Same rationale as the probe: the handshake names the session that will
  // actually serve, so the static rule is judged against that version. Only
  // the version is read here; the shape is validated where it always was, so
  // a malformed handshake still returns a closed result rather than throwing.
  const serving = isText(handshake?.clientVersion) ? handshake.clientVersion : clientVersion;
  const rule = evaluateVersionContract(adapter, { clientVersion: serving,
    protocolContract: reportedProtocol(adapter, handshake?.protocolContract) });
  const base = { ok: false, reasonCode: null, clientVersion: null,
    protocolContract: rule.protocolContract, modes: [],
    opaqueEndpointRef: null, leaseUntil: null };
  const closedResult = reasonCode => deepFreeze({ ...base, reasonCode });
  if (rule.reasonCode !== null) return closedResult(rule.reasonCode);
  if (handshake === null || handshake === undefined) return closedResult("handshake_failed");
  const facts = validateNativeHandshakeShape(handshake);
  if (facts.supported !== true) {
    return deepFreeze({ ...base, reasonCode: facts.reasonCode ?? "handshake_failed",
      ...(Object.hasOwn(facts, "launchOption") ? { launchOption: facts.launchOption } : {}) });
  }
  if (facts.protocolContract !== rule.protocolContract) return closedResult("protocol_mismatch");
  const modes = orderedModes(facts.modes);
  if (!modes.includes("livePush")) return closedResult("handshake_failed");
  // `serving` is a text version whenever the rule admitted it: every other
  // shape leaves evaluateVersionContract at "version_unavailable" above.
  return deepFreeze({ ok: true, reasonCode: null, clientVersion: serving,
    protocolContract: rule.protocolContract, modes,
    opaqueEndpointRef: facts.opaqueEndpointRef, leaseUntil: facts.leaseUntil });
}
