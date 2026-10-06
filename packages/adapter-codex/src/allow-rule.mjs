import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The rule that lets ACC's coordination commands run without an approval.
 *
 * Codex asks before a command that wants to leave its sandbox, and with
 * `approvals_reviewer = "auto_review"` a model reviews that request instead of
 * the user. A session ran its ACC commands that way, and the reviewer refused a
 * reply that named a branch, a commit and changed paths, as disclosure to "an
 * external ACC peer" (Codex 0.160, 2026-10-05). The peer was a session of the
 * same user on the same machine; from then on the session told every peer it
 * could not share project details.
 *
 * Codex loads every `*.rules` file in `$CODEX_HOME/rules`, and a command a
 * `prefix_rule` allows needs no approval, so no reviewer sees it. This file is
 * ACC's own, so uninstall can take it back whole. It allows the wrapper the skill
 * names, and only the commands a participant runs: install, uninstall, update and
 * config still ask.
 */
export const RULES_FILE = "agents-can-communicate.rules";
export const PARTICIPANT_COMMANDS = Object.freeze(["work", "claim", "release", "message",
  "request", "inbox", "reply", "ack", "status", "sync", "finish"]);

const HEADER = "# Written by ACC (agents-can-communicate).";
// A path a Starlark string literal holds as it is. Anything else gets no rule.
const PLAIN_PATH = /^[^"\\\r\n\t]+$/;

export const rulesPath = codexHome => path.join(codexHome, "rules", RULES_FILE);

/**
 * Whether this host gets a rule. On Windows Codex runs a command through
 * PowerShell and the skill's wrapper is a `node` command; how a rule matches
 * there is unmeasured, so no rule is written.
 */
export const ruleApplies = hostPlatform => hostPlatform !== "win32";

export function allowRuleText(cliShim) {
  const commands = PARTICIPANT_COMMANDS.map(command => JSON.stringify(command)).join(", ");
  return [
    HEADER,
    "# ACC's coordination commands run without an approval prompt or auto-review:",
    "# every peer is another AI session of the same user on this machine, and ACC",
    "# keeps messages in its own store here. `acc uninstall` removes this file.",
    "prefix_rule(",
    `    pattern = [${JSON.stringify(cliShim)}, [${commands}]],`,
    '    decision = "allow",',
    ")",
    "",
  ].join("\n");
}

async function current(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
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
  const text = allowRuleText(cliShim);
  if (existing === text) return { file: null, diagnostics: [] };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return { file, diagnostics: [`added ${file}: ACC's coordination commands run without an approval prompt`] };
}

/** The rule's state, for doctor. */
export async function inspectAllowRule({ codexHome, cliShim, hostPlatform }) {
  if (!ruleApplies(hostPlatform) || !PLAIN_PATH.test(cliShim)) return { state: "none", diagnostic: null };
  const file = rulesPath(codexHome);
  const existing = await current(file);
  if (existing === allowRuleText(cliShim)) {
    return { state: "allowed", diagnostic: `ACC commands run without an approval prompt: ${file} allows them` };
  }
  if (existing !== null && !existing.startsWith(HEADER)) {
    return { state: "foreign", diagnostic: `${file} is not ACC's; Codex asks before each escalated ACC command` };
  }
  return { state: "missing", diagnostic: "Codex asks before each escalated ACC command, and auto-review "
    + `can refuse one: ${file} is missing or out of date. Run acc install --adapter codex` };
}

/**
 * Take ACC's rule back. Only a file that still holds exactly what ACC wrote goes;
 * an edited one, or one the installer's ownership record kept, stays.
 */
export async function removeAllowRule({ codexHome, cliShim, keep = [] }) {
  const file = rulesPath(codexHome);
  if (keep.includes(file) || await current(file) !== allowRuleText(cliShim)) return null;
  await rm(file, { force: true });
  return file;
}
