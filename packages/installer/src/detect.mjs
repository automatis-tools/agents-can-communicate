import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { effectiveCapabilities, evaluateNativeEligibility, validateNativeActivationPlan }
  from "@agents-can-communicate/adapter-sdk";

import { resolveExecutable, shellOf, shimDirFor } from "./native-activation.mjs";

const run = promisify(execFile);

// Reasons the client itself will not change within an install: unsupported,
// as opposed to degraded, which a repaired probe or shell may lift.
const STATIC_REASONS = new Set(["native_delivery_unsupported", "platform_not_captured",
  "version_unavailable", "prerelease_not_captured", "below_minimum_version",
  "known_bad_version"]);

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

// Clients print their version in their own shape: "codex-cli 0.147.0", a bare
// "0.36.1", a banner with the number somewhere inside. The number is extracted
// where it can be, and the raw line is kept either way - "present, version
// unreadable" is a real state and hiding it would make the client look absent.
const VERSION = /(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\b|$)/;

/**
 * Ask the operating system what a client reports as its version.
 *
 * Spawning is the only way to know, and it is the only side effect detection
 * has: nothing is written, and a client that is not installed simply fails to
 * start.
 */
export const spawnProbe = async (command, args) => {
  const { stdout, stderr } = await run(command, args);
  return `${stdout}${stderr}`.trim();
};

const withTimeout = (work, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  work.then(resolve, reject).finally(() => clearTimeout(timer));
});

/**
 * Read-only report of what is on this machine.
 *
 * One failing adapter never ends the run. A client whose config is unreadable is
 * exactly the case someone is running this command to find out about, and
 * letting it throw would hide the other three behind it.
 */
const unsupported = reasonCode => ({ state: "unsupported", reasonCode, realExecutable: null,
  probe: null, eligibility: null, activationPlan: null });
const degraded = (reasonCode, facts) => ({ state: "degraded", reasonCode, activationPlan: null,
  ...facts });

/**
 * The read-only native-delivery report for one detected client: which
 * executable a shim would exec, what the adapter's probe saw, the static
 * verdict, and the activation the adapter would ask for. Version, help, and
 * protocol probes only; never a service mutation.
 */
async function detectNative(adapter, entry, { context, platform, probeTimeoutMs, pathEnv }) {
  if (adapter.nativeDelivery === undefined) return unsupported("native_delivery_unsupported");
  try {
    const realExecutable = await resolveExecutable(adapter.client.command, { pathEnv,
      exclude: [typeof context?.stateRoot === "string" ? shimDirFor(context.stateRoot) : null] });
    if (realExecutable === null) return unsupported("version_unavailable");
    const facts = { realExecutable, probe: null, eligibility: null };
    try {
      facts.probe = await withTimeout(Promise.resolve(adapter.probeNativeDelivery({
        realExecutable, timeoutMs: probeTimeoutMs })), probeTimeoutMs,
      `${adapter.id} native probe`);
    } catch {
      facts.probe = null;
    }
    try {
      facts.eligibility = evaluateNativeEligibility(adapter,
        { clientVersion: entry.version, platform, probe: facts.probe });
    } catch {
      facts.eligibility = { eligible: false, reasonCode: "feature_probe_failed" };
    }
    if (facts.eligibility.eligible !== true) {
      const reasonCode = facts.eligibility.reasonCode ?? "feature_probe_failed";
      return STATIC_REASONS.has(reasonCode)
        ? { ...unsupported(reasonCode), ...facts } : degraded(reasonCode, facts);
    }
    let activationPlan;
    try {
      activationPlan = validateNativeActivationPlan(await adapter.planNativeActivation({
        detection: { realExecutable, version: entry.version, platform, probe: facts.probe },
        context, livePolicy: null }));
    } catch {
      return degraded("feature_probe_failed", facts);
    }
    if (!activationPlan.eligible) return degraded(activationPlan.reasonCode, facts);
    const shell = context?.shell ?? null;
    if (activationPlan.mechanisms.some(item => item.kind === "shell-bootstrap") && shell !== "zsh") {
      return { ...degraded("unsupported_shell", facts), activationPlan };
    }
    return { state: "eligible", reasonCode: null, ...facts, activationPlan };
  } catch {
    return degraded("feature_probe_failed", { realExecutable: null, probe: null, eligibility: null });
  }
}

export async function detectInstallation({ adapters, context, probe = spawnProbe,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  platform = `${process.platform}-${process.arch}`,
  pathEnv = context?.env?.PATH ?? process.env.PATH ?? "" }) {
  const entries = await Promise.all([...adapters]
    // Ordered by id so two runs can be diffed, and so a plan built from this is
    // deterministic rather than dependent on registry order.
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(async adapter => {
      const entry = { adapterId: adapter.id, displayName: adapter.displayName,
        present: false, version: null, versionOutput: null, installed: false,
        diagnostics: [], needsAction: [], capabilities: effectiveCapabilities(adapter),
        deliveryDiagnostic: null, error: null };

      try {
        const output = await withTimeout(
          // The declared binary, never the adapter id. Guessing the id made
          // every client whose command differs from it look uninstalled.
          Promise.resolve(probe(adapter.client.command,
            adapter.client.versionArgs ?? ["--version"])),
          probeTimeoutMs, `${adapter.id} version probe`);
        if (typeof output === "string" && output !== "") {
          entry.present = true;
          entry.versionOutput = output;
          entry.version = VERSION.exec(output)?.[1] ?? null;
        }
      } catch (error) {
        entry.error = error.message;
      }
      entry.capabilities = effectiveCapabilities(adapter,
        { clientVersion: entry.version, platform });
      entry.nativeDelivery = entry.present
        ? await detectNative(adapter, entry, { context, platform, probeTimeoutMs, pathEnv })
        : unsupported(adapter.nativeDelivery === undefined
          ? "native_delivery_unsupported" : "version_unavailable");

      try {
        const detected = await adapter.detect(context);
        entry.diagnostics = [...(detected.diagnostics ?? [])];
        // What a person has to do, as opposed to what is true. Adapters that
        // have nothing to ask for say nothing.
        entry.needsAction = detected.needsAction ?? [];
        // "Installed" is the adapter's own answer, phrased in its own terms.
        // The installer does not second-guess it by looking at files it does
        // not understand.
        entry.installed = entry.diagnostics.some(line =>
          /registered|installed/.test(line) && !/not registered|not installed/.test(line));
      } catch (error) {
        entry.error = entry.error ?? error.message;
      }
      if (entry.nativeDelivery.state !== "eligible"
        && typeof adapter.deliveryFallback?.diagnostic === "string") {
        const nextTurnDowngraded = adapter.capabilities?.delivery?.nextTurn === true
          && entry.capabilities?.delivery?.nextTurn !== true;
        entry.deliveryDiagnostic = nextTurnDowngraded
          ? `${adapter.displayName} ${entry.version ?? "unknown version"} has no certified `
            + `next-turn delivery on ${platform}; ${adapter.deliveryFallback.diagnostic}`
          : adapter.deliveryFallback.diagnostic;
        entry.diagnostics.push(entry.deliveryDiagnostic);
      }
      return entry;
    }));
  return entries;
}
