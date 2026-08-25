import { COMMANDS } from "./args.mjs";

/**
 * What `acc` says to a person who has just installed it.
 *
 * The list of commands is read from the command table, so a command that exists
 * is always listed. Only the heading a command sits under and its one line are
 * written here, and the tests prove both cover every command in the table.
 *
 * The required options are deliberately not repeated: the parser already
 * answers `acc claim` with "claim requires --resource", which is the same
 * answer at the moment it is actually needed.
 */
const GROUPS = Object.freeze([
  ["Set up", ["install", "uninstall", "doctor", "config"]],
  ["In a session", ["status", "sync", "work", "claim", "release", "ack", "message",
    "request", "task", "workstream", "decide", "finish"]],
  ["Driven by adapters, not by people", ["attach", "heartbeat", "detach"]],
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
  request: "ask another agent to do something: the work and the why, in one call",
  task: "create work, --take it, or move its --state along",
  workstream: "group related work, and steer it with --take / --release",
  decide: "record what was settled, so the next session does not reopen it",
  finish: "write the handoff and release what this session held",
  attach: "open a session; an adapter calls this, not a person",
  heartbeat: "say the session is still alive",
  detach: "close a session",
  help: "this list",
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

export function helpText() {
  const width = Math.max(...Object.keys(COMMANDS).map(name => name.length)) + 4;
  const lines = ["acc - several agents in one workspace, none of them in charge", ""];
  for (const { heading, commands } of describeCommands()) {
    lines.push(heading);
    for (const { name, summary } of commands) {
      lines.push(`  ${`acc ${name}`.padEnd(width)}  ${summary}`);
    }
    lines.push("");
  }
  // A URL rather than a path: only `docs/CAPABILITIES.md` is packed, so a
  // reference to `docs/CLI.md` would name a file the installed package does not
  // have. The test alongside holds this to the repository the manifest names.
  lines.push("Every command takes --json for machine output and --cwd to choose the workspace.",
    `Full reference: ${DOCS}`);
  return lines.join("\n");
}
