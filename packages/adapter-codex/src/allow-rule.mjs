import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The rule that allows ACC's participant commands when the runtime honors it.
 *
 * Codex asks before a command that wants to leave its sandbox, and with
 * `approvals_reviewer = "auto_review"` a model reviews that request instead of
 * the user. A session ran its ACC commands that way, and the reviewer refused a
 * reply that named a branch, a commit and changed paths, as disclosure to "an
 * external ACC peer" (Codex 0.160, 2026-10-05). The peer was a session of the
 * same user on the same machine; from then on the session told every peer it
 * could not share project details.
 *
 * Codex loads `*.rules` files from its active config layers. An installed rule
 * is not proof that a model, managed policy or explicit escalation skips review.
 * This file allows only the participant commands through ACC's wrapper.
 */
export const RULES_FILE = "agents-can-communicate.rules";
export const PARTICIPANT_COMMANDS = Object.freeze(["work", "claim", "release", "message",
  "request", "inbox", "reply", "ack", "status", "sync", "finish"]);

const HEADER = "# Written by ACC (agents-can-communicate).";
const NOTE = ["# ACC's participant commands are allowed where Codex honors this rule.",
  "# Runtime approval remains subject to the active model and permission policy.",
  "# ACC uses local state and the user's own sessions. `acc uninstall` removes this file."];
const LEGACY_NOTE = ["# ACC's coordination commands run without an approval prompt or auto-review:",
  "# every peer is another AI session of the same user on this machine, and ACC",
  "# keeps messages in its own store here. `acc uninstall` removes this file."];
// A path a Starlark string literal holds as it is. Anything else gets no rule.
const PLAIN_PATH = /^[^"\\\r\n\t]+$/;

export const rulesPath = codexHome => path.join(codexHome, "rules", RULES_FILE);

/**
 * Whether this host gets a rule. On Windows Codex runs a command through
 * PowerShell and the skill's wrapper is a `node` command; how a rule matches
 * there is unmeasured, so no rule is written.
 */
export const ruleApplies = hostPlatform => hostPlatform !== "win32";

function ruleText(cliShim, note) {
  const commands = PARTICIPANT_COMMANDS.map(command => JSON.stringify(command)).join(", ");
  return [
    HEADER,
    ...note,
    "prefix_rule(",
    `    pattern = [${JSON.stringify(cliShim)}, [${commands}]],`,
    '    decision = "allow",',
    ")",
    "",
  ].join("\n");
}

export const allowRuleText = cliShim => ruleText(cliShim, NOTE);

async function current(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Whether a file still holds exactly what ACC generates, for whichever wrapper
 * path it names. Only such a file is ACC's to replace or remove: one that keeps
 * the header but drops a command is the operator narrowing what skips approval,
 * and a reinstall must not widen it again (AI review of #261).
 */
export function accGenerated(text) {
  const named = /pattern = \[("(?:[^"\\]|\\.)*")/.exec(text ?? "");
  if (named === null) return false;
  try {
    const shim = JSON.parse(named[1]);
    return text === allowRuleText(shim) || text === ruleText(shim, LEGACY_NOTE);
  } catch {
    return false;
  }
}

/** Write ACC's rule. Returns the file it changed, or null, and what to say. */
export async function writeAllowRule({ codexHome, cliShim, hostPlatform }) {
  if (!ruleApplies(hostPlatform)) return { file: null, diagnostics: [] };
  const file = rulesPath(codexHome);
  if (!PLAIN_PATH.test(cliShim)) {
    return { file: null, diagnostics: [`no Codex rule for ACC's wrapper ${cliShim}: its path `
      + "cannot be written in a rule as it is, so Codex asks before each escalated ACC command"] };
  }
  const existing = await current(file);
  if (existing !== null && !existing.startsWith(HEADER)) {
    return { file: null, diagnostics: [`${file} is not ACC's, so ACC left it as it is; `
      + "Codex asks before each escalated ACC command"] };
  }
  if (existing !== null && !accGenerated(existing)) {
    return { file: null, diagnostics: [`${file} was edited since ACC wrote it, so ACC left it as `
      + "it is; review it, or delete it and run acc install --adapter codex"] };
  }
  const text = allowRuleText(cliShim);
  if (existing === text) return { file: null, diagnostics: [] };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return { file, diagnostics: [`added ${file}: ACC participant command rule installed; runtime approval remains unverified`] };
}

/**
 * Whether ACC's rule will carry ACC's commands once this install has run: the
 * platform has one, the wrapper's path can be written in it, and the file is
 * absent or still exactly ACC's. An edited or foreign file is left alone, so
 * it cannot be counted on (#329).
 */
export async function ruleAllowsCommands({ codexHome, cliShim, hostPlatform }) {
  if (!ruleApplies(hostPlatform) || !PLAIN_PATH.test(cliShim)) return false;
  const existing = await current(rulesPath(codexHome));
  return existing === null || accGenerated(existing);
}

/** The rule's state, for doctor. */
export async function inspectAllowRule({ codexHome, cliShim, hostPlatform }) {
  if (!ruleApplies(hostPlatform) || !PLAIN_PATH.test(cliShim)) return { state: "none", diagnostic: null };
  const file = rulesPath(codexHome);
  const existing = await current(file);
  if (existing === allowRuleText(cliShim) || existing === ruleText(cliShim, LEGACY_NOTE)) {
    return { state: "allowed", diagnostic: `ACC command rule installed: ${file}; runtime approval remains unverified `
      + "for the active model, permission policy and explicit escalation" };
  }
  if (existing !== null && !existing.startsWith(HEADER)) {
    return { state: "foreign", diagnostic: `${file} is not ACC's; Codex asks before each escalated ACC command` };
  }
  if (existing !== null && !accGenerated(existing)) {
    return { state: "edited", diagnostic: `${file} was edited since ACC wrote it; ACC leaves it as it is` };
  }
  return { state: "missing", diagnostic: "Codex asks before each escalated ACC command, and auto-review "
    + `can refuse one: ${file} is missing or out of date. Run acc install --adapter codex` };
}

/**
 * Take ACC's rule back. Only a file that still holds exactly what ACC wrote goes;
 * an edited one, or one the installer's ownership record kept, stays.
 */
export async function removeAllowRule({ codexHome, keep = [] }) {
  const file = rulesPath(codexHome);
  if (keep.includes(file) || !accGenerated(await current(file))) return null;
  await rm(file, { force: true });
  return file;
}
