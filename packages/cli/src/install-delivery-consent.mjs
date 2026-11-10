import { LIVE_POLICIES, livePolicyOf } from "@agents-can-communicate/installer";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

/** What a client that can receive live delivery gets when nobody chose otherwise. */
export const DEFAULT_LIVE_POLICY = "actionable";

const DECISION_SOURCES = new Set([
  "interactive-accepted",
  "interactive-declined",
  "explicit-option",
  "noninteractive-default",
  "unsupported-default",
  "default-enabled",
  "legacy-unknown",
]);
// A person made these. `off` from any other source is ACC's own and yields to the default.
const DELIBERATE_SOURCES = new Set([
  "interactive-accepted", "interactive-declined", "explicit-option",
]);

const legacyDecision = () => ({ source: "legacy-unknown", completeSetup: false });

function validDecision(record) {
  const decision = record?.deliveryDecision;
  if (!(decision !== null && typeof decision === "object"
    && DECISION_SOURCES.has(decision.source)
    && typeof decision.completeSetup === "boolean")) return false;
  if (Object.hasOwn(decision, "installPrerequisites")
    && (typeof decision.installPrerequisites !== "boolean"
      || (decision.installPrerequisites && !decision.completeSetup))) return false;

  const enabled = livePolicyOf(record) !== "off";
  if (["interactive-accepted", "default-enabled"].includes(decision.source)) {
    return decision.completeSetup && enabled;
  }
  if (decision.source === "interactive-declined") return !decision.completeSetup && !enabled;
  if (decision.source === "explicit-option") return decision.completeSetup === enabled;
  if (["noninteractive-default", "unsupported-default"].includes(decision.source)) {
    return !decision.completeSetup && !enabled;
  }
  return decision.completeSetup === false;
}

export function decisionOf(record) {
  return validDecision(record)
    ? { source: record.deliveryDecision.source,
      completeSetup: record.deliveryDecision.completeSetup,
      ...(Object.hasOwn(record.deliveryDecision, "installPrerequisites")
        ? { installPrerequisites: record.deliveryDecision.installPrerequisites } : {}) }
    : legacyDecision();
}

const isEligible = entry => entry.nativeDelivery?.state === "eligible"
  || entry.nativeDelivery?.consentAvailable === true;

const needsExpandedSetup = entry => ["needed", "blocked"]
  .includes(entry.nativeServiceSetup?.state);
const needsPrerequisite = entry => entry.nativeServiceSetup?.requiresInstall === true;

/** True when a client that is already on still lacks setup it has not been refused. */
function setupStillOwed(entry, record) {
  const decision = decisionOf(record);
  const expandsSetup = needsExpandedSetup(entry) && !decision.completeSetup
    && !(needsPrerequisite(entry) && decision.installPrerequisites === false);
  const expandsPrerequisite = needsPrerequisite(entry)
    && !Object.hasOwn(decision, "installPrerequisites");
  return expandsSetup || expandsPrerequisite;
}

/**
 * The delivery every client gets when this run names no policy, for an install and
 * for an update alike: on for each client that can receive it. An off stays only
 * when a person chose it, so a client ACC left off comes on once it is able to.
 */
export function defaultDelivery({ detected, recorded }) {
  const recordedById = new Map(recorded.map(install => [install.adapterId, install]));
  const deliveryByAdapter = {};
  const deliveryDecisionByAdapter = {};
  const turnedOn = [];

  for (const entry of detected) {
    const record = recordedById.get(entry.adapterId);
    const previous = livePolicyOf(record);
    const enabled = { source: "default-enabled", completeSetup: true,
      ...(needsPrerequisite(entry) ? { installPrerequisites: true } : {}) };

    deliveryByAdapter[entry.adapterId] = previous;
    if (record !== undefined) deliveryDecisionByAdapter[entry.adapterId] = decisionOf(record);

    if (!isEligible(entry)) {
      deliveryDecisionByAdapter[entry.adapterId] ??= {
        source: "unsupported-default", completeSetup: false,
      };
      continue;
    }

    if (previous === "off") {
      if (validDecision(record) && DELIBERATE_SOURCES.has(record.deliveryDecision.source)) continue;
      deliveryByAdapter[entry.adapterId] = DEFAULT_LIVE_POLICY;
      deliveryDecisionByAdapter[entry.adapterId] = enabled;
      turnedOn.push(entry);
    } else if (setupStillOwed(entry, record)) {
      deliveryDecisionByAdapter[entry.adapterId] = enabled;
    }
  }
  return { deliveryByAdapter, deliveryDecisionByAdapter, turnedOn };
}

/** What this run tells the operator about the clients the default turned on. */
export function deliveryNotes(entries, dryRun) {
  if (entries.length === 0) return [];
  const names = entries.map(entry => entry.displayName ?? entry.adapterId).join(", ");
  return [
    `${dryRun ? "would turn" : "turned"} live delivery on for ${names} (experimental): a request or `
      + "question can wake an idle session and spend tokens; acc install --delivery off turns it off",
    ...(entries.some(entry => entry.adapterId === "claude_code")
      ? ["Claude Code sessions that bypass permission prompts ask before each ACC wake; "
        + "set Claude Code's crossSessionInbound to accept to take wakes without asking"] : []),
  ];
}

/** Decide delivery for an install: the operator's explicit option, or the default. */
export function decideDelivery({ options, detected, recorded, dryRun }) {
  const explicit = options.delivery;
  if (explicit !== undefined && !LIVE_POLICIES.includes(explicit)) {
    throw new AccError(EXIT.USAGE, `unknown delivery policy: ${explicit}`, { delivery: explicit });
  }

  if (explicit === undefined) {
    const decided = defaultDelivery({ detected, recorded });
    return { ...decided, notes: deliveryNotes(decided.turnedOn, dryRun) };
  }

  const deliveryByAdapter = {};
  const deliveryDecisionByAdapter = {};
  for (const entry of detected) {
    deliveryByAdapter[entry.adapterId] = explicit;
    deliveryDecisionByAdapter[entry.adapterId] = {
      source: "explicit-option", completeSetup: explicit !== "off",
      ...(needsPrerequisite(entry) ? { installPrerequisites: explicit !== "off" } : {}),
    };
  }
  return { deliveryByAdapter, deliveryDecisionByAdapter, turnedOn: [], notes: [] };
}
