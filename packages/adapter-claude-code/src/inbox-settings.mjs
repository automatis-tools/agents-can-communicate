import { readFile } from "node:fs/promises";
import path from "node:path";

// What Claude Code does with a wake from a sender that attests no permission
// mode - ACC never attests one. A session that bypasses permission prompts
// holds it for approval; `crossSessionInbound` overrides that both ways. ACC
// reads the same inputs so the sender is told what will happen, and never
// changes any of them.

const MAX_BYTES = 256 * 1024;
const RECEPTIONS = Object.freeze(["delivered", "held", "refused"]);

export const MANAGED_SETTINGS = Object.freeze({
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
  linux: "/etc/claude-code/managed-settings.json",
  win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
});

async function readSettings(file) {
  try {
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) return null;
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const text = value => (typeof value === "string" && value !== "" ? value : null);

/**
 * The two inputs, each from the first file that sets it, in Claude Code's own
 * order: managed policy, then the project's local and shared settings, then
 * the user's.
 */
export async function readInboundSettings({ configDir, projectDir, managedSettingsPath }) {
  const files = [managedSettingsPath,
    ...(typeof projectDir === "string" && path.isAbsolute(projectDir)
      ? [path.join(projectDir, ".claude", "settings.local.json"),
        path.join(projectDir, ".claude", "settings.json")] : []),
    path.join(configDir, "settings.json")].filter(file => typeof file === "string");
  const layers = await Promise.all(files.map(readSettings));
  const first = pick => layers.map(layer => (layer === null ? null : pick(layer))).find(value => value !== null)
    ?? null;
  return {
    crossSessionInbound: first(layer => text(layer.crossSessionInbound)),
    defaultMode: first(layer => text(layer.permissions?.defaultMode)),
  };
}

export function receptionOf({ permissionMode, crossSessionInbound }) {
  if (crossSessionInbound === "accept") return "delivered";
  if (crossSessionInbound === "refuse") return "refused";
  if (crossSessionInbound === "hold" || permissionMode === "bypassPermissions") return "held";
  return "delivered";
}

export const isReception = value => RECEPTIONS.includes(value);

/**
 * What `acc doctor` tells a person who turned live delivery on: the machine-wide
 * view, from managed policy and the user's settings. A project can still set
 * its own value; the bind reads that one per session.
 */
export async function inboundStatus({ configDir, managedSettingsPath }) {
  const userFile = path.join(configDir, "settings.json");
  for (const file of [managedSettingsPath, userFile].filter(item => typeof item === "string")) {
    const value = text((await readSettings(file))?.crossSessionInbound);
    if (value === "accept") return { state: "accepted", diagnostic: null };
    if (value === "refuse") {
      return { state: "refused", diagnostic: `crossSessionInbound is "refuse" in ${file}, so `
        + "Claude Code drops every ACC wake; messages arrive with each next turn; set it to "
        + "\"accept\" for live delivery" };
    }
    if (value !== null) break;
  }
  return { state: "attention", diagnostic: "a session that bypasses permission prompts asks "
    + `before each ACC wake; add "crossSessionInbound": "accept" to ${userFile} to take wakes `
    + "without asking; the next turn shows the message either way" };
}

