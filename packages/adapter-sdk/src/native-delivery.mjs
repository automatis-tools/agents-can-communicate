import { CONTRACT_ID, FINGERPRINT, HANDSHAKE_KEYS, KNOWN_BAD_REASON, NATIVE_ACTIVATION_KINDS,
  NATIVE_BINDING_MODES, NATIVE_PLATFORMS, PROBE_KEYS, TIMESTAMP, assertModes,
  assertReasonCode, closed, compareStableVersions, deepFreeze, isPlainObject, isText,
  parseStableVersion, usage } from "./native-vocabulary.mjs";

// The native-delivery compatibility contract: a per-platform minimum that is a
// real passing capture, one or more anchors naming the captured protocol, an
// explicit denylist, and the activation kinds an adapter may ask the installer
// for. There is deliberately no maximum: a newer stable client is admitted only
// when a current read-only probe and a per-session handshake confirm the same
// protocol contract. Exact-version certification still governs every other
// capability; this rule is used for native live delivery alone.

export { NATIVE_ACTIVATION_KINDS, NATIVE_BINDING_MODES, NATIVE_PLATFORMS, NATIVE_REASON_CODES,
  compareStableVersions, parseStableVersion } from "./native-vocabulary.mjs";
export { validateNativeActivationPlan } from "./native-activation.mjs";

const orderedModes = modes => NATIVE_BINDING_MODES.filter(mode => modes.includes(mode));

export function validateNativeDeliveryContract(value, { certification, client }) {
  const policySource = Object.hasOwn(value ?? {}, "policySource")
    ? value.policySource : "bootstrap-environment";
  closed({ ...value, policySource },
    ["minimumByPlatform", "anchors", "knownBad", "activationKinds", "policySource"],
    "nativeDelivery");
  if (!["installation-record", "bootstrap-environment"].includes(policySource)) {
    usage("nativeDelivery.policySource must be installation-record or bootstrap-environment");
  }
  const minimums = value.minimumByPlatform;
  if (!isPlainObject(minimums) || Object.keys(minimums).length === 0) {
    usage("nativeDelivery.minimumByPlatform must map at least one captured platform to a version");
  }
  for (const [platform, version] of Object.entries(minimums)) {
    if (!NATIVE_PLATFORMS.includes(platform)) {
      usage(`nativeDelivery.minimumByPlatform names an unknown platform ${platform}`);
    }
    if (parseStableVersion(version) === null) {
      usage(`nativeDelivery.minimumByPlatform ${platform} must be a stable version`);
    }
  }
  if (!Array.isArray(value.anchors) || value.anchors.length === 0) {
    usage("nativeDelivery.anchors must name at least one passing capture");
  }
  const anchors = value.anchors.map((anchor, index) => {
    closed(anchor, ["platform", "version", "protocolContract"], "nativeDelivery anchor");
    const minimum = minimums[anchor.platform];
    if (minimum === undefined) {
      usage(`nativeDelivery anchor ${index} platform ${anchor.platform} has no minimum`);
    }
    if (parseStableVersion(anchor.version) === null
      || compareStableVersions(anchor.version, minimum) < 0) {
      usage(`nativeDelivery anchor ${index} version must be a stable version at or above the minimum`);
    }
    if (!isText(anchor.protocolContract) || !CONTRACT_ID.test(anchor.protocolContract)) {
      usage(`nativeDelivery anchor ${index} protocolContract must be a closed identifier`);
    }
    const proven = (certification?.evidence ?? []).some(item => item.result === "pass"
      && item.capability === "delivery.livePush" && item.client === client
      && item.version === anchor.version && item.platform === anchor.platform);
    if (!proven) {
      usage(`nativeDelivery anchor ${anchor.version} on ${anchor.platform} has no passing `
        + "delivery.livePush certification", { anchor });
    }
    return { ...anchor };
  });
  for (const [platform, minimum] of Object.entries(minimums)) {
    if (!anchors.some(anchor => anchor.platform === platform && anchor.version === minimum)) {
      usage(`nativeDelivery minimum ${minimum} on ${platform} must be the first passing capture: `
        + "no anchor matches it");
    }
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
    || kinds.some(kind => !NATIVE_ACTIVATION_KINDS.includes(kind))) {
    usage(`nativeDelivery.activationKinds must be unique entries of ${NATIVE_ACTIVATION_KINDS.join(", ")}`);
  }
  return deepFreeze({ minimumByPlatform: { ...minimums }, anchors, knownBad,
    activationKinds: [...kinds], policySource });
}

function knownBadHit(contract, version) {
  return contract.knownBad.some(entry => (Object.hasOwn(entry, "version")
    ? compareStableVersions(version, entry.version) === 0
    : compareStableVersions(version, entry.from) >= 0 && compareStableVersions(version, entry.to) <= 0));
}

// Judges one reported client version against an adapter's captured
// native-delivery contract: is the platform captured, is the version at or
// above the captured minimum, and is it not on the denylist. Returns
// { reasonCode, minimumVersion, protocolContract }; reasonCode is null when
// the version satisfies the contract, otherwise one of
// "native_delivery_unsupported", "platform_not_captured",
// "version_unavailable", "prerelease_not_captured", "below_minimum_version",
// or "known_bad_version".
//
// This is the static half of the rule only: it never contacts the client, so
// passing here proves nothing about whether a live probe or handshake
// actually confirms the protocol or delivery modes. A caller that needs that
// layers a probe or handshake check on top (see evaluateNativeEligibility,
// validateNativeHandshake below, and the delivery router's own offer check,
// which uses this function alone because a response already carries no probe
// or handshake shape to check further).
export function evaluateVersionContract(adapter, { clientVersion, platform }) {
  const contract = adapter?.nativeDelivery;
  if (contract === undefined) {
    return { reasonCode: "native_delivery_unsupported", minimumVersion: null, protocolContract: null };
  }
  const uncaptured = { reasonCode: "platform_not_captured", minimumVersion: null,
    protocolContract: null };
  // validateNativeDeliveryContract guarantees a minimum map and a matching
  // anchor, but this function is also handed adapter objects that never went
  // through it. A declaration missing either half has captured nothing for
  // this platform, which is a closed answer - not a TypeError raised deep
  // inside a delivery offer, far from the declaration that caused it. Every
  // other entry point below already answers malformed input this way.
  if (typeof platform !== "string" || !isPlainObject(contract.minimumByPlatform)) return uncaptured;
  const minimumVersion = contract.minimumByPlatform[platform] ?? null;
  if (minimumVersion === null) return uncaptured;
  const anchor = (Array.isArray(contract.anchors) ? contract.anchors : [])
    .find(item => item.platform === platform && item.version === minimumVersion);
  if (anchor === undefined) return uncaptured;
  const facts = { minimumVersion, protocolContract: anchor.protocolContract };
  if (!isText(clientVersion)) return { ...facts, reasonCode: "version_unavailable" };
  if (parseStableVersion(clientVersion) === null) {
    return { ...facts, reasonCode: "prerelease_not_captured" };
  }
  if (compareStableVersions(clientVersion, minimumVersion) < 0) {
    return { ...facts, reasonCode: "below_minimum_version" };
  }
  if (knownBadHit(contract, clientVersion)) return { ...facts, reasonCode: "known_bad_version" };
  return { ...facts, reasonCode: null };
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

export function evaluateNativeEligibility(adapter, { clientVersion, platform, probe }) {
  // The probe names the process that will serve the delivery. Judging the
  // detected binary instead refuses a service that satisfies the contract.
  // Only the version is read here; the shape is validated where it always was,
  // so a malformed probe still returns a closed result rather than throwing.
  const serving = isText(probe?.clientVersion) ? probe.clientVersion : clientVersion;
  const rule = evaluateVersionContract(adapter, { clientVersion: serving, platform });
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
  closed(handshake, HANDSHAKE_KEYS, "native handshake");
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
  return handshake;
}

// The per-session half: the same static rule again, then the adapter's live
// handshake facts. The launch-time executable fingerprint stays probe-only.
export function validateNativeHandshake(adapter, { clientVersion, platform, handshake }) {
  // Same rationale as the probe: the handshake names the session that will
  // actually serve, so the static rule is judged against that version. Only
  // the version is read here; the shape is validated where it always was, so
  // a malformed handshake still returns a closed result rather than throwing.
  const serving = isText(handshake?.clientVersion) ? handshake.clientVersion : clientVersion;
  const rule = evaluateVersionContract(adapter, { clientVersion: serving, platform });
  const base = { ok: false, reasonCode: null, protocolContract: rule.protocolContract, modes: [],
    opaqueEndpointRef: null, leaseUntil: null };
  const closedResult = reasonCode => deepFreeze({ ...base, reasonCode });
  if (rule.reasonCode !== null) return closedResult(rule.reasonCode);
  if (handshake === null || handshake === undefined) return closedResult("handshake_failed");
  const facts = validateNativeHandshakeShape(handshake);
  if (facts.supported !== true) return closedResult(facts.reasonCode ?? "handshake_failed");
  if (facts.protocolContract !== rule.protocolContract) return closedResult("protocol_mismatch");
  const modes = orderedModes(facts.modes);
  if (!modes.includes("livePush")) return closedResult("handshake_failed");
  return deepFreeze({ ok: true, reasonCode: null, protocolContract: rule.protocolContract, modes,
    opaqueEndpointRef: facts.opaqueEndpointRef, leaseUntil: facts.leaseUntil });
}
