import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ACC_NAMESPACE, ACC_REGISTERED_EVENTS } from "../src/install.mjs";
import { fakeAgy } from "./fake-agy.mjs";

/**
 * A home with Antigravity CLI's own settings in it, for the allow-rule tests.
 *
 * `~/.gemini/antigravity-cli/settings.json` is the file 1.2.12 read its
 * `permissions.allow` from, captured 2026-09-27 (issue #214). The keys beside
 * `permissions` are the ones the capture machine had, and the two rules already
 * there are the kinds the operator had added by hand: the relay start, whose
 * quotes are around an argument, and one full ACC command with its session.
 */
export async function agyHome(t, { name = "acc-agy-allow-" } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), name)));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".gemini", "config"), { recursive: true });
  const wrapper = path.join(home, ".gemini", "config", "acc", "acc-cli.sh");
  const settings = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  const agy = fakeAgy();
  const context = { home, dataHome: path.join(home, "acc-data"),
    antigravityWorkspace: path.join(home, "project"), runAgy: agy.run,
    probeHooks: async () => ({ hooks: [{ name: ACC_NAMESPACE, enabled: true,
      actions: ACC_REGISTERED_EVENTS.map(event => ({ event })) }] }) };
  const theirs = {
    colorScheme: "dark",
    trustedWorkspaces: [path.join(home, "project")],
    permissions: { allow: [
      `command(sh "${path.join(home, ".gemini", "config", "acc", "acc-relay.sh")}" start)`,
      `command("${wrapper}" inbox --session session_1 --workspace 'acc://w')`,
    ] },
  };
  const write = async value => {
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, typeof value === "string" ? value
      : `${JSON.stringify(value, null, 2)}\n`);
  };
  const read = () => readFile(settings, "utf8");
  const exists = () => stat(settings).then(() => true, () => false);
  return { home, wrapper, settings, rule: `command(${wrapper})`, context, theirs, write,
    read, exists, agy };
}

/** What `acc install` hands the adapter once the operator said yes to both questions. */
export const CONSENTED = Object.freeze({ requestedLivePolicy: "actionable",
  livePolicy: "actionable",
  deliveryDecision: { source: "interactive-accepted", completeSetup: true,
    allowCommands: true } });

/** The decisions that must leave the operator's settings alone. */
export const WITHOUT_CONSENT = Object.freeze([
  ["a direct adapter call with no delivery policy", {}],
  // Incoherent, and exactly what a refresh hands over from a hand-edited record:
  // the policy is what the operator asked for, and it is off.
  ["live delivery off, even with a yes on record", { requestedLivePolicy: "off",
    livePolicy: "off", deliveryDecision: { source: "interactive-accepted",
      completeSetup: true, allowCommands: true } }],
  ["live delivery on and the prompt question declined", { requestedLivePolicy: "actionable",
    livePolicy: "actionable", deliveryDecision: { source: "interactive-accepted",
      completeSetup: true, allowCommands: false } }],
  ["live delivery on and the prompt question never asked", { requestedLivePolicy: "actionable",
    livePolicy: "actionable", deliveryDecision: { source: "interactive-accepted",
      completeSetup: true } }],
]);
