import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { blankJson, isShellWord, removeIfEmpty, writeForeignJson }
  from "@agents-can-communicate/adapter-sdk";

/**
 * The one allow rule ACC may add to Antigravity CLI's settings, with consent.
 *
 * Antigravity CLI asks before every shell command. On 1.2.12 a live push woke an
 * idle session and its first ACC command waited at an approval prompt with
 * nobody there, so the peer never got an answer (issue #214). A rule under
 * `permissions.allow` removes the prompt. What 1.2.12 was captured doing:
 *
 * - The file is `~/.gemini/antigravity-cli/settings.json`, read once at startup.
 *   `~/.gemini/settings.json` belongs to Gemini CLI and is never touched here.
 * - A one-word rule is a prefix: `command("<wrapper>")` let `<wrapper> help`
 *   run unasked.
 * - A command whose first word is quoted matched no rule at all, quoted or not;
 *   quotes around an argument are fine. So the skill names the wrapper bare,
 *   and a wrapper path that only stays one word inside quotes cannot be allowed.
 *
 * ACC writes the bare form, `command(<wrapper>)`. The file is the operator's:
 * one that does not parse, or whose `permissions.allow` is not a list, is never
 * rewritten. What ACC added is recorded in its own data home - the rule and the
 * containers it had to create - and uninstall takes back exactly that.
 */
export const agySettingsPath = home => path.join(home, ".gemini", "antigravity-cli",
  "settings.json");
export const cliWrapperPath = home => path.join(home, ".gemini", "config", "acc", "acc-cli.sh");
export const accAllowRule = wrapper => `command(${wrapper})`;

// Forms that already allow every command starting with the bare wrapper: the
// one ACC writes, and the quoted one-word form 1.2.12 was captured matching.
const allowingForms = wrapper => [accAllowRule(wrapper), `command("${wrapper}")`];

// Beside the `created-*` markers, for the same reason: the installer removes the
// shim directory before uninstall runs. `acc doctor` passes the state root.
const claimDir = ({ dataHome, stateRoot, home }) => typeof dataHome === "string" && dataHome !== ""
  ? path.join(dataHome, "acc", "adapter-antigravity")
  : typeof stateRoot === "string" && stateRoot !== ""
    ? path.join(stateRoot, "adapter-antigravity")
    : path.join(home, ".gemini", "config", "acc");
const claimPath = (context, file) => path.join(claimDir(context),
  `allow-rule-${Buffer.from(file).toString("base64url")}`);

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

async function readClaim(file) {
  try {
    const claim = JSON.parse(await readFile(file, "utf8"));
    return typeof claim?.rule === "string" ? claim : null;
  } catch {
    return null;
  }
}

/** The settings as the client would read them, or why ACC must not edit them. */
async function readSettings(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing", value: {}, allow: [] };
    return { state: "unreadable", reason: `could not be read (${error.code ?? error.message})` };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "unreadable", reason: "is not valid JSON" };
  }
  if (!isObject(value)) return { state: "unreadable", reason: "does not hold a JSON object" };
  if (value.permissions !== undefined && !isObject(value.permissions)) {
    return { state: "unreadable", reason: "has a permissions value that is not an object" };
  }
  const allow = value.permissions?.allow;
  if (allow !== undefined && !Array.isArray(allow)) {
    return { state: "unreadable", reason: "has a permissions.allow value that is not a list" };
  }
  return { state: "read", value, allow: allow ?? [] };
}

const RESTART = "Antigravity CLI reads it at startup, so a session started before it was "
  + "added still asks until agy restarts";

/** What the rule's state is on this machine, in words doctor can print. */
export async function inspectAllowRule(context) {
  const file = agySettingsPath(context.home);
  const wrapper = cliWrapperPath(context.home);
  const rule = accAllowRule(wrapper);
  const base = { file, wrapper, rule, owned: false, setup: null };
  if (!isShellWord(wrapper)) {
    return { ...base, state: "unmatchable", diagnostic: "each ACC command waits for approval, "
      + "so a live wake stops at the agent's first ACC command until someone answers the "
      + `approval prompt. No allow rule can remove it here: the wrapper ${wrapper} stays one `
      + "shell word only inside quotes, and Antigravity CLI matches no rule against a command "
      + "whose first word is quoted. ACC adds the prefix rule to permissions.allow in "
      + `${file} when the wrapper path holds only letters, digits and . _ - /` };
  }
  const settings = await readSettings(file);
  if (settings.state === "unreadable") {
    return { ...base, state: "unreadable", diagnostic: `${file} ${settings.reason}, so ACC `
      + "leaves it as it is and cannot tell whether ACC commands wait for approval; a live "
      + "wake stops at the agent's first ACC command while they do. Repair the file, then run "
      + `acc install --adapter antigravity to add ${rule} to permissions.allow` };
  }
  const matched = settings.allow.find(entry => allowingForms(wrapper).includes(entry));
  if (matched !== undefined) {
    const claim = await readClaim(claimPath(context, file));
    const owned = claim?.rule === matched;
    return { ...base, state: "allowed", owned, diagnostic: "ACC commands run without an "
      + `approval prompt: permissions.allow in ${file} holds ${matched}`
      + `${owned ? ", added by ACC with your consent" : ""}. ${RESTART}` };
  }
  return { ...base, state: "prompts",
    setup: `add ${rule} to permissions.allow in ${file}; every command that starts with `
      + `${wrapper} then runs without an approval prompt, in sessions started afterwards`,
    diagnostic: "each ACC command waits for approval, so a live wake stops at the agent's "
      + "first ACC command until someone answers the approval prompt. The allow rule "
      + `${rule} in permissions.allow of ${file} removes the prompt: to let ACC add it, run `
      + "acc install --adapter antigravity with the delivery policy you use (--delivery "
      + "actionable or all), or add it yourself; then restart agy" };
}

/** Did the operator consent to the rule for a live delivery they asked for. */
export const wantsAllowRule = context =>
  (context.requestedLivePolicy ?? context.livePolicy ?? "off") !== "off"
  && context.deliveryDecision?.allowCommands === true;

async function addRule(context, found) {
  const settings = await readSettings(found.file);
  const claimFile = claimPath(context, found.file);
  const previous = (await readClaim(claimFile))?.created ?? {};
  const created = {
    file: previous.file === true || settings.state === "missing",
    permissions: previous.permissions === true || settings.value.permissions === undefined,
    allow: previous.allow === true || settings.value.permissions?.allow === undefined,
  };
  // The claim first: a crash between the two leaves a claim with no rule, which
  // uninstall drops, rather than a rule nobody can tell is ACC's.
  await mkdir(path.dirname(claimFile), { recursive: true });
  await writeFile(claimFile, `${JSON.stringify({ file: found.file, rule: found.rule,
    created })}\n`);
  await writeForeignJson(found.file, { ...settings.value, permissions: {
    ...settings.value.permissions, allow: [...settings.allow, found.rule] } },
  { readFile, writeFile, mkdir });
}

/**
 * Take back the rule ACC recorded adding, and the containers it created if they
 * are empty. Anything else in the file stays, including a rule the operator
 * added in the same words after ACC's was gone.
 */
export async function withdrawAllowRule(context) {
  const file = agySettingsPath(context.home);
  const claimFile = claimPath(context, file);
  const claim = await readClaim(claimFile);
  if (claim === null) return { changes: [], diagnostics: [], needsAction: [] };
  const settings = await readSettings(file);
  if (settings.state === "unreadable") {
    // Kept, so the next install or uninstall can finish once the file reads.
    return { changes: [], diagnostics: [], needsAction: [`${file} ${settings.reason}; ACC `
      + `left it as it is and still has to remove its ${claim.rule} from permissions.allow`] };
  }
  const at = settings.allow.lastIndexOf(claim.rule);
  if (at === -1) {
    await rm(claimFile, { force: true });
    return { changes: [], diagnostics: [], needsAction: [] };
  }
  const permissions = { ...settings.value.permissions, allow: settings.allow.toSpliced(at, 1) };
  if (claim.created?.allow === true && permissions.allow.length === 0) delete permissions.allow;
  const next = { ...settings.value, permissions };
  if (claim.created?.permissions === true && Object.keys(permissions).length === 0) {
    delete next.permissions;
  }
  await writeForeignJson(file, next, { readFile, writeFile, mkdir });
  if (claim.created?.file === true) {
    await removeIfEmpty(file, { readFile, rm, isEmpty: blankJson() });
  }
  await rm(claimFile, { force: true });
  return { changes: [file], diagnostics: [`removed ACC's ${claim.rule} from ${file}`],
    needsAction: [] };
}

/** Make the settings match the recorded decision, at install time. */
export async function reconcileAllowRule(context) {
  if (!wantsAllowRule(context)) return withdrawAllowRule(context);
  const found = await inspectAllowRule(context);
  if (found.state === "unmatchable" || found.state === "unreadable") {
    return { changes: [], diagnostics: [found.diagnostic], needsAction: [found.diagnostic] };
  }
  if (found.state === "allowed") {
    return { changes: [], diagnostics: [found.diagnostic], needsAction: [] };
  }
  await addRule(context, found);
  return { changes: [found.file], needsAction: [], diagnostics: [`added ${found.rule} to `
    + `permissions.allow in ${found.file}: ACC commands run without an approval prompt in `
    + "Antigravity sessions started from now on; restart agy for a session already open"] };
}
