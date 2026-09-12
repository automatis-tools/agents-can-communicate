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
  return decision !== null && typeof decision === "object"
    && DECISION_SOURCES.has(decision.source)
    && typeof decision.completeSetup === "boolean";
}

function decisionOf(record) {
  return validDecision(record)
    ? { source: record.deliveryDecision.source,
      completeSetup: record.deliveryDecision.completeSetup }
    : legacyDecision();
}

const isEligible = entry => entry.nativeDelivery?.state === "eligible"
  || entry.nativeDelivery?.consentAvailable === true;

const needsExpandedSetup = entry => ["needed", "blocked"]
  .includes(entry.nativeServiceSetup?.state);

const isInteractive = runtime => typeof runtime.isInteractive === "function"
  && runtime.isInteractive() === true;

function questionFor(entries) {
  const names = entries.map(entry => entry.displayName ?? entry.adapterId).join(", ");
  const setup = [...new Set(entries.map(entry => entry.outgoingDelivery?.setup)
    .filter(value => typeof value === "string"))];
  const channels = entries.some(entry => (entry.nativeDelivery?.activationPlan?.mechanisms ?? [])
    .some(mechanism => mechanism.kind === "shell-bootstrap"
      && (mechanism.prefixArgs ?? []).some(argument => argument.startsWith("--"))));
  return [
    `Complete automatic peer-request setup for ${names}? (experimental)`,
    "  Yes: automatic turns can spend tokens without waiting for you.",
    "       Configure the required local permission grants.",
    ...(entries.some(entry => entry.adapterId === "codex")
      ? ["       Start a missing supported Codex service."] : []),
    ...setup.map(note => `       ${note}`),
    ...(channels ? ["       Allow Claude Code development Channels when prompted at startup."] : []),
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
      && !decisionOf(record).completeSetup;
    const freshDecision = previous === "off" && !alreadyDecided;
    if (!freshDecision && !expandsLegacyOptIn) {
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
    }
  }

  const notes = explicit === undefined && dryRun && withheld > 0
    ? ["interactive choices were not made: this preview keeps native delivery off for "
      + `${withheld} eligible client(s) without a recorded opt-in`]
    : [];
  return { deliveryByAdapter, deliveryDecisionByAdapter, asked, notes };
}
