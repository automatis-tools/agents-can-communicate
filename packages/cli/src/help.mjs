import { CLAIM_ENFORCEMENTS, CLAIM_MODES, GENERIC_MESSAGE_KINDS, HANDOFF_STATUSES,
  INTENT_MODES, INTENT_STATES, OBLIGATIONS } from "@agents-can-communicate/protocol";
import { LIVE_POLICIES } from "@agents-can-communicate/installer";

import { COMMANDS } from "./args.mjs";
import { needsOwner } from "./session-owner.mjs";

/**
 * What `acc` says to a person who has just installed it.
 *
 * The list of commands is read from the command table, so a command that exists
 * is always listed. Only the heading a command sits under and its one line are
 * written here, and the tests prove both cover every command in the table.
 *
 * Per-command help also reads the parser's option table, and exposes the
 * protocol's enum choices before a caller has to attempt a mutation.
 */
const GROUPS = Object.freeze([
  ["Set up", ["install", "uninstall", "doctor", "config"]],
  ["In a session", ["status", "sync", "work", "claim", "release", "inbox", "reply",
    "ack", "message", "request", "finish"]],
  ["Session lifecycle", ["attach", "heartbeat", "detach"]],
  ["About acc", ["help", "version", "update"]],
]);

const SUMMARY = Object.freeze({
  install: "install adapters for the clients on this machine",
  uninstall: "remove what acc wrote, keep what you edited",
  doctor: "clients, versions, install health, and what to run next",
  config: "write or check acc.workspace.json (init | validate)",
  status: "who else is here, what they hold, how protected this workspace is",
  sync: "what has happened since a cursor; silent while you are alone",
  work: "publish what this session is doing, or --clear when it has stopped",
  claim: "reserve a resource; exit 5 when someone else already holds it",
  release: "give a claim back",
  ack: "answer a message that asked for one, so it stops asking",
  message: "send a typed message to named participants",
  inbox: "read addressed messages; --message also inspects acknowledged ones",
  reply: "reply to one message and acknowledge it in the same operation",
  request: "ask another agent to do something in a reply-required message",
  finish: "write the handoff and release what this session held",
  attach: "open a manual session and return its session/generation pair",
  heartbeat: "say the session is still alive",
  detach: "close a session",
  help: "list commands, or inspect one with acc help <command>",
  version: "print the version that is installed",
  update: "ask npm whether a newer acc exists; --apply installs it",
});

/** The same list `acc help --json` returns, so a tool can read it too. */
export function describeCommands() {
  return GROUPS.map(([heading, names]) => ({
    heading,
    commands: names.map(name => ({
      name,
      summary: SUMMARY[name],
      required: COMMANDS[name].required ?? [],
      subcommands: COMMANDS[name].subcommands ?? [],
    })),
  }));
}

const DOCS = "https://github.com/automatis-tools/agents-can-communicate"
  + "/blob/main/docs/CLI.md";

const CHOICES = Object.freeze({
  work: { mode: INTENT_MODES, state: INTENT_STATES },
  claim: { mode: CLAIM_MODES, enforcement: CLAIM_ENFORCEMENTS },
  finish: { status: HANDOFF_STATUSES },
  message: { type: GENERIC_MESSAGE_KINDS, obligation: OBLIGATIONS },
  sync: { scope: ["delta", "full"] },
  install: { delivery: LIVE_POLICIES },
});

const NOTES = Object.freeze({
  attach: ["Native hooks already manage their own session. Attach only for a manual CLI session.",
    "Keep the returned session and generation together for subsequent calls.",
    "--cadence is a positive interval in milliseconds."],
  work: ["Provide --summary unless using --clear. Default mode: edit; default state: active."],
  claim: ["--lease is in seconds. Default mode: exclusive; default enforcement: advisory.",
    "For files, use file:src/a.mjs or file:src/**. A claim may conflict with a peer."],
  release: ["Provide --claim or --resource. Releasing another owner's claim requires human or policy authority."],
  message: ["Default type: note. question/request require --to and obligation reply; note uses none.",
    "decision permits none, or acknowledge when addressed. Use reply for answers and finish for handoffs."],
  inbox: ["Without --message, returns unresolved mail. Exact acknowledged inspection leaves the receipt unchanged."],
  reply: ["Returns the outgoing message/delivery plus the original acknowledged receipt."],
  finish: ["Default status: partial. Records a handoff, releases claims, and closes this ACC session."],
  config: ["init writes optional workspace configuration; validate only checks it.",
    "init requires confirmation or --yes. --force bypasses the active-session check; an existing config is never overwritten."],
});

export function describeCommand(name, subcommand) {
  const spec = COMMANDS[name];
  return { name, summary: SUMMARY[name],
    ...(subcommand === undefined ? {} : { subcommand }),
    required: spec.required ?? [], optional: spec.optional ?? [],
    repeated: spec.repeated ?? [], flags: spec.flags ?? [],
    subcommands: spec.subcommands ?? [], choices: CHOICES[name] ?? {},
    notes: [...(NOTES[name] ?? []), ...(needsOwner(name)
      ? ["Use your own --session and --generation from the ACC hook or manual attach; never a peer's pair."]
      : [])] };
}

export function commandHelpText(command) {
  const { name, summary, subcommand, subcommands, choices, notes } = command;
  const suffix = subcommand !== undefined ? ` ${subcommand}`
    : subcommands.length > 0 ? ` <${subcommands.join("|")}>` : "";
  const lines = [`acc ${name} - ${summary}`, "", `Usage: acc ${name}${suffix} [options]`, ""];
  for (const [key, label] of [["required", "Required"], ["optional", "Optional"],
    ["repeated", "Repeatable"], ["flags", "Flags"]]) {
    if (command[key].length === 0) continue;
    lines.push(`${label}:`);
    for (const option of command[key]) {
      const value = key === "flags" ? "" : ` <${choices[option]?.join("|") ?? "value"}>`;
      lines.push(`  --${option}${value}`);
    }
    lines.push("");
  }
  lines.push("Global: --json, --cwd <path>, --workspace <config>, --help, -h", "", ...notes,
    `Full reference: ${DOCS}`);
  return lines.join("\n");
}

export function helpText() {
  const width = Math.max(...Object.keys(COMMANDS).map(name => name.length)) + 4;
  const lines = ["acc - coordinate the agent sessions you already opened", ""];
  for (const { heading, commands } of describeCommands()) {
    lines.push(heading);
    for (const { name, summary } of commands) {
      lines.push(`  ${`acc ${name}`.padEnd(width)}  ${summary}`);
    }
    lines.push("");
  }
  // The longer reference is linked to the repository named in the manifest;
  // installed command help supplies local syntax without needing that link.
  lines.push("Every command takes --json for machine output and --cwd to choose the workspace.",
    "Use acc <command> --help or acc help <command> for options and accepted values.",
    `Full reference: ${DOCS}`);
  return lines.join("\n");
}
