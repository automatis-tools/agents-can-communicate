import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { isShellWord, writeForeignJson } from "@agents-can-communicate/adapter-sdk";

import { accAllowRule, allowingForms, claimPath, cliWrapperPath, readClaim } from "./allow-rule.mjs";

/**
 * The allow rule for ACC commands in Antigravity 2.0, the desktop app.
 *
 * The desktop keeps its own grants: picking "always allow" for ACC's wrapper on
 * 2.19.1 wrote `command(<wrapper>)` to `~/.gemini/config/config.json` under
 * `userSettings.globalPermissionGrants.allow`, and the rule ACC writes for
 * Antigravity CLI in `~/.gemini/antigravity-cli/settings.json` never stopped
 * the desktop from asking. The desktop creates config.json at its first
 * launch, so a machine without the file has no desktop to allow anything for,
 * and ACC does not create it.
 */
export const desktopConfigPath = home => path.join(home, ".gemini", "config", "config.json");

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const none = { changes: [], diagnostics: [], needsAction: [] };

async function readConfig(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", reason: `could not be read (${error.code ?? error.message})` };
  }
  let value;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { state: "unreadable", reason: "is not valid JSON" };
  }
  if (!isObject(value)) return { state: "unreadable", reason: "does not hold a JSON object" };
  const settings = value.userSettings;
  if (settings !== undefined && !isObject(settings)) {
    return { state: "unreadable", reason: "has a userSettings value that is not an object" };
  }
  const grants = settings?.globalPermissionGrants;
  if (grants !== undefined && !isObject(grants)) {
    return { state: "unreadable", reason: "has a globalPermissionGrants value that is not an object" };
  }
  const allow = grants?.allow;
  if (allow !== undefined && !Array.isArray(allow)) {
    return { state: "unreadable", reason: "has a globalPermissionGrants.allow value that is not a list" };
  }
  return { state: "read", value, allow: allow ?? [] };
}

/** What the desktop rule's state is on this machine, in words doctor can print. */
export async function inspectDesktopRule(context) {
  const file = desktopConfigPath(context.home);
  const hostPlatform = context.hostPlatform ?? process.platform;
  const wrapper = cliWrapperPath(context.home, hostPlatform);
  const rule = accAllowRule(wrapper);
  const base = { file, wrapper, rule, owned: false };
  if (hostPlatform === "win32" || !isShellWord(wrapper)) {
    return { ...base, state: "unmatchable", diagnostic: "Antigravity (the desktop app) asks before "
      + "each ACC command: no allow rule can name ACC's wrapper here" };
  }
  const config = await readConfig(file);
  if (config.state === "missing") return { ...base, state: "absent", diagnostic: null };
  if (config.state === "unreadable") {
    return { ...base, state: "unreadable", diagnostic: `${file} ${config.reason}, so ACC leaves it `
      + "as it is, and Antigravity (the desktop app) asks before each ACC command. Repair the "
      + `file, then run acc install --adapter antigravity to add ${rule}` };
  }
  const matched = config.allow.find(entry => allowingForms(wrapper).includes(entry));
  if (matched !== undefined) {
    const owned = (await readClaim(claimPath(context, file, "desktop")))?.rule === matched;
    return { ...base, state: "allowed", owned, diagnostic: "ACC commands run without an approval "
      + `prompt in Antigravity (the desktop app): ${file} allows ${matched}`
      + `${owned ? ", added by ACC" : ""}` };
  }
  return { ...base, state: "prompts", diagnostic: "Antigravity (the desktop app) asks before each "
    + `ACC command: ${file} does not allow ${rule}. Run acc install --adapter antigravity` };
}

/** Add the rule where the desktop keeps its grants, when the desktop is there. */
export async function ensureDesktopRule(context) {
  const found = await inspectDesktopRule(context);
  if (found.state === "absent") return none;
  if (found.state === "unmatchable" || found.state === "unreadable") {
    return { changes: [], diagnostics: [found.diagnostic], needsAction: [found.diagnostic] };
  }
  if (found.state === "allowed") return { ...none, diagnostics: [found.diagnostic] };
  const config = await readConfig(found.file);
  const settings = config.value.userSettings;
  const grants = settings?.globalPermissionGrants;
  const created = { userSettings: settings === undefined, grants: grants === undefined,
    allow: grants?.allow === undefined };
  const claimFile = claimPath(context, found.file, "desktop");
  // The claim first, as for the CLI rule: a crash between the two leaves a claim
  // with no rule, which uninstall drops, never a rule nobody can tell is ACC's.
  await mkdir(path.dirname(claimFile), { recursive: true });
  await writeFile(claimFile, `${JSON.stringify({ file: found.file, rule: found.rule, created })}\n`);
  await writeForeignJson(found.file, { ...config.value, userSettings: { ...settings,
    globalPermissionGrants: { ...grants, allow: [...config.allow, found.rule] } } },
  { readFile, writeFile, mkdir });
  return { changes: [found.file], needsAction: [], diagnostics: [`added ${found.rule} to `
    + `${found.file}: ACC commands run without an approval prompt in Antigravity (the desktop `
    + "app); restart the app if it is open"] };
}

/** Take back exactly what ACC recorded adding, and containers it created if empty. */
export async function withdrawDesktopRule(context) {
  const file = desktopConfigPath(context.home);
  const claimFile = claimPath(context, file, "desktop");
  const claim = await readClaim(claimFile);
  if (claim === null) return none;
  const config = await readConfig(file);
  if (config.state === "missing") {
    await rm(claimFile, { force: true });
    return none;
  }
  if (config.state === "unreadable") {
    return { changes: [], diagnostics: [], needsAction: [`${file} ${config.reason}; ACC left it as `
      + `it is and still has to remove its ${claim.rule}`] };
  }
  if (!config.allow.includes(claim.rule)) {
    await rm(claimFile, { force: true });
    return none;
  }
  const grants = { ...config.value.userSettings.globalPermissionGrants,
    allow: config.allow.filter(rule => rule !== claim.rule) };
  if (claim.created?.allow === true && grants.allow.length === 0) delete grants.allow;
  const settings = { ...config.value.userSettings, globalPermissionGrants: grants };
  if (claim.created?.grants === true && Object.keys(grants).length === 0) {
    delete settings.globalPermissionGrants;
  }
  const next = { ...config.value, userSettings: settings };
  if (claim.created?.userSettings === true && Object.keys(settings).length === 0) delete next.userSettings;
  await writeForeignJson(file, next, { readFile, writeFile, mkdir });
  await rm(claimFile, { force: true });
  return { changes: [file], diagnostics: [`removed ACC's ${claim.rule} from ${file}`], needsAction: [] };
}
