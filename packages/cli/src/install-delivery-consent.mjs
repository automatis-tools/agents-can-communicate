import { LIVE_POLICIES, livePolicyOf } from "@agents-can-communicate/installer";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

const DECISION_SOURCES = new Set([
  "interactive-accepted",
  "interactive-declined",
  "explicit-option",
  "noninteractive-default",
  "unsupported-default",
  "legacy-unknown",
]);
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
  if (decision.source === "interactive-accepted") return decision.completeSetup && enabled;
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

const isInteractive = runtime => typeof runtime.isInteractive === "function"
  && runtime.isInteractive() === true;

function questionFor(entries) {
  const names = entries.map(entry => entry.displayName ?? entry.adapterId).join(", ");
  const setup = [...new Set(entries.map(entry => entry.outgoingDelivery?.setup)
    .filter(value => typeof value === "string"))];
  return [
    `Complete automatic peer-request setup for ${names}? (experimental)`,
    "  Yes: automatic turns can spend tokens without waiting for you.",
    "       Configure the required local permission grants.",
    ...(entries.some(entry => entry.adapterId === "codex")
      ? ["       Start a missing supported Codex service."] : []),
    ...entries.filter(needsPrerequisite).map(entry =>
      `       Download the official Codex ${entry.nativeServiceSetup.cliVersion} standalone package for its service; retain your existing codex command.`),
    ...setup.map(note => `       ${note}`),
    ...(entries.some(entry => entry.adapterId === "claude_code")
      ? ["       Claude Code sessions that bypass permission prompts ask before each ACC wake."] : []),
    "  No: keep current delivery policies and use available next-turn hooks or acc inbox.",
  ].join("\n");
}

/** Decide delivery once for all clients whose complete setup has no recorded answer. */
export async function decideDelivery({ options, detected, recorded, runtime, dryRun }) {
  const explicit = options.delivery;
  if (explicit !== undefined && !LIVE_POLICIES.includes(explicit)) {
    throw new AccError(EXIT.USAGE, `unknown delivery policy: ${explicit}`, { delivery: explicit });
  }

  const recordedById = new Map(recorded.map(install => [install.adapterId, install]));
  const deliveryByAdapter = {};
  const deliveryDecisionByAdapter = {};
  const candidates = [];
  let withheld = 0;

  for (const entry of detected) {
    const record = recordedById.get(entry.adapterId);
    const previous = livePolicyOf(record);
    const eligible = isEligible(entry);

    if (explicit !== undefined) {
      deliveryByAdapter[entry.adapterId] = explicit;
      deliveryDecisionByAdapter[entry.adapterId] = {
        source: "explicit-option", completeSetup: explicit !== "off",
        ...(needsPrerequisite(entry) ? { installPrerequisites: explicit !== "off" } : {}),
      };
      continue;
    }

    deliveryByAdapter[entry.adapterId] = previous;
    if (record !== undefined) {
      deliveryDecisionByAdapter[entry.adapterId] = decisionOf(record);
    }

    if (!eligible) {
      deliveryDecisionByAdapter[entry.adapterId] ??= {
        source: "unsupported-default", completeSetup: false,
      };
      continue;
    }

    const alreadyDecided = validDecision(record)
      && DELIBERATE_SOURCES.has(record.deliveryDecision.source);
    const expandsLegacyOptIn = previous !== "off" && needsExpandedSetup(entry)
      && !decisionOf(record).completeSetup
      && !(needsPrerequisite(entry) && decisionOf(record).installPrerequisites === false);
    const freshDecision = previous === "off" && !alreadyDecided;
    const expandsPrerequisite = previous !== "off" && needsPrerequisite(entry)
      && !Object.hasOwn(decisionOf(record), "installPrerequisites");
    if (!freshDecision && !expandsLegacyOptIn && !expandsPrerequisite) {
      deliveryDecisionByAdapter[entry.adapterId] ??= legacyDecision();
      continue;
    }

    if (dryRun || !isInteractive(runtime)) {
      if (record === undefined) {
        deliveryDecisionByAdapter[entry.adapterId] = {
          source: "noninteractive-default", completeSetup: false,
        };
      }
      if (dryRun && freshDecision) withheld += 1;
      continue;
    }
    candidates.push(entry);
  }

  const asked = candidates.map(entry => entry.adapterId);
  if (candidates.length > 0) {
    const yes = await runtime.confirm(questionFor(candidates),
      { input: runtime.input, output: runtime.output }) === true;
    for (const entry of candidates) {
      const record = recordedById.get(entry.adapterId);
      const previous = livePolicyOf(record);
      deliveryByAdapter[entry.adapterId] = yes
        ? (previous === "off" ? "actionable" : previous)
        : previous;
      deliveryDecisionByAdapter[entry.adapterId] = yes
        ? { source: "interactive-accepted", completeSetup: true }
        : previous === "off"
          ? { source: "interactive-declined", completeSetup: false }
          : decisionOf(record);
      if (needsPrerequisite(entry)) {
        deliveryDecisionByAdapter[entry.adapterId].installPrerequisites = yes;
      }
    }
  }

  const notes = explicit === undefined && dryRun && withheld > 0
    ? ["interactive choices were not made: this preview keeps native delivery off for "
      + `${withheld} eligible client(s) without a recorded opt-in`]
    : [];
  return { deliveryByAdapter, deliveryDecisionByAdapter, asked, notes };
}
