// The text ACC puts in front of a model, rendered by an installed package for
// the context-token measurement (#135). Each surface is what a Claude Code hook
// returns as additionalContext in one coordination state; every client's hook
// projects the same text. Nothing here talks to a model.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

// Peer bodies of an ordinary size: a question, a request with a scope, a note.
export const PEER_MESSAGES = Object.freeze([
  ["peer-a", ["message", "--to", "measured", "--type", "question", "--subject", "parser boundary",
    "--body", "Can I take file:src/parser/** after your next commit? I need to change how "
      + "tokens are grouped, and I will not touch the lexer or its tests."]],
  ["peer-b", ["request", "--to", "measured", "--title", "review inbox transitions",
    "--detail", "Check the queued -> retrieved and reply -> acknowledged transitions in "
      + "packages/core/src/receipts.mjs. Return only defects with a failing input; style "
      + "remarks are out of scope. The change is on branch fix/receipts."]],
  ["peer-a", ["message", "--to", "measured", "--type", "note", "--subject", "schema verified",
    "--body", "Record v2 accepts a nullable pid; no migration is planned."]],
]);

function contextOf(stdout) {
  if (stdout.trim() === "") return "";
  return JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
}

/**
 * Render every surface in a data home of its own, through the installed
 * `acc` and `acc-hook`. `env` is the isolated environment of the measurement.
 */
export async function renderSurfaces({ packageRoot, project, dataHome, env }) {
  const acc = path.join(packageRoot, "bin", "acc.mjs");
  const hookBin = path.join(packageRoot, "bin", "acc-hook.mjs");
  const own = { ...env, ACC_DATA_HOME: dataHome };
  const hook = async (event, payload) => {
    const pending = run(process.execPath, [hookBin, "claude_code"],
      { cwd: project, env: { ...own, ACC_PARTICIPANT: "measured" } });
    pending.child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: "measured-session",
      cwd: project, ...payload }));
    return contextOf((await pending).stdout);
  };
  const cli = async (args, credentials = []) => JSON.parse((await run(process.execPath,
    [acc, ...args, ...credentials, "--cwd", project, "--json"], { cwd: project, env: own })).stdout).data;
  const prompt = () => hook("UserPromptSubmit", { prompt: "continue" });

  const surfaces = {};
  surfaces.sessionStart = await hook("SessionStart", { source: "startup" });
  surfaces.ownerHeader = await prompt();
  const peers = {};
  for (const name of ["peer-a", "peer-b"]) {
    const attached = await cli(["attach", "--participant", name]);
    peers[name] = ["--session", attached.sessionId, "--generation", attached.generation];
  }
  surfaces.peersPresent = await prompt();
  for (const [from, args] of PEER_MESSAGES) await cli(args, peers[from]);
  surfaces.busyTurn = await prompt();
  surfaces.afterBusy = await prompt();

  const adapters = path.join(packageRoot, "node_modules", "@agents-can-communicate");
  const { wakeText } = await import(pathToFileURL(
    path.join(adapters, "adapter-claude-code", "src", "inbox-delivery.mjs")).href);
  surfaces.claudeWake = wakeText("message_0123456789abcdefghijkl");
  return surfaces;
}

/** The acc skill the installer wrote into a client home, with its CLI path baked in. */
export async function installedSkill(home) {
  const entries = await readdir(home, { recursive: true, withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== "SKILL.md") continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = await readFile(file, "utf8");
    if (/^name: acc$/m.test(text) && !text.includes("{{ACC}}")) found.push({ file, text });
  }
  // Claude Code keeps a marketplace copy and loads the one in its plugin cache.
  const loaded = found.length > 1 ? found.filter(item => item.file.includes(`${path.sep}cache${path.sep}`)) : found;
  if (loaded.length !== 1) throw new Error(`expected one loaded acc skill: ${found.map(item => item.file)}`);
  return loaded[0].text;
}

/** The description a client lists for the skill before the model loads it. */
export function skillListing(skill) {
  return /^description:\s*(.*)$/m.exec(skill)?.[1] ?? "";
}
