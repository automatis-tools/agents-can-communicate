import { CLAIM_ENFORCEMENTS, CLAIM_MODES, GENERIC_MESSAGE_KINDS, HANDOFF_STATUSES,
  INTENT_MODES, INTENT_STATES, MESSAGE_KINDS, OBLIGATIONS } from "@agents-can-communicate/protocol";
import { LIVE_POLICIES } from "@agents-can-communicate/installer";

import { COMMANDS, commandSpec } from "./args.mjs";
import { ALL_ADAPTERS } from "./install-command.mjs";
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
  sync: "events since a cursor, or bounded message history",
  work: "publish what this session is doing, or --clear when it has stopped",
  claim: "reserve a resource; exit 5 when someone else already holds it",
  release: "give a claim back",
  ack: "answer a message that asked for one, so it stops asking",
  message: "send a typed message to named participants",
  inbox: "list pending message headers; --message reads one complete message",
  reply: "reply to one message and acknowledge it in the same operation",
  request: "ask another agent to do something in a reply-required message",
  finish: "write the handoff and release what this session held",
  attach: "open a manual session and return its session/generation pair",
  heartbeat: "say the session is still alive",
  detach: "close a session",
  help: "list commands, or inspect one with acc help <command>",
  version: "print the version that is installed",
  update: "install a newer acc and refresh clients; --check only reports",
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

const ADAPTER_IDS = Object.freeze(ALL_ADAPTERS().map(adapter => adapter.id));
const CHOICES = Object.freeze({
  work: { mode: INTENT_MODES, state: INTENT_STATES },
  claim: { mode: CLAIM_MODES, enforcement: CLAIM_ENFORCEMENTS },
  finish: { status: HANDOFF_STATUSES },
  message: { type: GENERIC_MESSAGE_KINDS, obligation: OBLIGATIONS },
  sync: { scope: ["delta", "full", "history"], type: MESSAGE_KINDS },
  install: { delivery: LIVE_POLICIES, adapter: ADAPTER_IDS },
  uninstall: { adapter: ADAPTER_IDS },
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
    "decision permits none, or acknowledge when addressed. Use reply for answers and finish for handoffs.",
    "For decisions, repeat --supersedes or --withdraws with 1..16 prior decision IDs; never combine the two.",
    "Changes inherit target recipients and authors, including offline participants. Any peer may record a change; competing branches remain visible."],
  inbox: ["Without --message, returns read-only {items, nextCursor} summary pages, newest first.",
    "Default: 20 items, at most 12000 bytes of formatted page JSON. --limit accepts 1..500.",
    "Continue with --cursor <nextCursor>; omit it to see new arrivals. Listing never retrieves bodies.",
    "Replaced decisions leave the pending list without changing receipts; exact inbox and history retain them.",
    "--message reads one complete addressed message, including acknowledged mail; do not combine with cursor or limit.",
    "Exact reads return a one-item array. Acknowledged inspection leaves the receipt unchanged."],
  sync: ["Default delta uses 16-digit event cursors. full adds an unbounded diagnostic snapshot.",
    "history lists read-only message summaries, newest first: default 20 items, at most 12000 bytes of formatted page JSON.",
    "With history, --type filters before paging; --cursor takes the complete message ID in nextCursor.",
    "history --type decision --current lists terminal decisions and withdrawals, including conflicts. Current means no recorded successor, not consensus.",
    "history --message reads one complete historical message without changing receipts; do not combine with cursor, limit, or type."],
  reply: ["Returns the outgoing message/delivery plus the original acknowledged receipt."],
  finish: ["Default status: partial. Records a handoff, releases claims, and closes this ACC session."],
  config: ["init writes optional workspace configuration; validate only checks it.",
    "Use acc config <subcommand> --help for its options."],
  update: ["Run acc update to install the latest release and refresh client integrations.",
    "Use acc update --check to only report whether a newer release exists.",
    "Automatic updates are on after acc install; activation waits for active clients and ACC processes.",
    "--auto on|off changes automatic updates; --pin VERSION holds an exact stable version; --pin none follows stable releases.",
    "--apply remains accepted as a compatibility alias for acc update."],
});

const CONFIG_HELP = Object.freeze({
  init: { summary: "write optional workspace configuration",
    notes: ["init requires confirmation or --yes. --force bypasses the active-session check; an existing config is never overwritten."] },
  validate: { summary: "check optional workspace configuration",
    notes: ["Checks acc.workspace.json in the selected directory without writing it."] },
});

export function describeCommand(name, subcommand) {
  const spec = commandSpec(name, subcommand);
  const detail = name === "config" ? CONFIG_HELP[subcommand] : undefined;
  return { name, summary: detail?.summary ?? SUMMARY[name],
    ...(subcommand === undefined ? {} : { subcommand }),
    required: spec.required ?? [], optional: spec.optional ?? [],
    repeated: spec.repeated ?? [], flags: spec.flags ?? [],
    subcommands: spec.subcommands ?? [], choices: CHOICES[name] ?? {},
    notes: [...(detail?.notes ?? NOTES[name] ?? []), ...(needsOwner(name)
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
  const globals = ["--json", "--help", "-h"];
  if (!["install", "uninstall", "update", "help", "version"].includes(name)) {
    globals.push("--cwd <path>");
    if (name !== "config" || subcommand !== "validate") globals.push("--workspace <config>");
  }
  lines.push(`Global: ${globals.join(", ")}`, "", ...notes,
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
  lines.push("Every command takes --json for machine output.",
    "Use acc <command> --help or acc help <command> for options and accepted values.",
    `Full reference: ${DOCS}`);
  return lines.join("\n");
}
