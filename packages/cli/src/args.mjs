import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Commands the model is offered stay few and high level; attach, heartbeat, and
// detach exist for adapters and are deliberately not advertised as model tools.
//
// `--session` and `--generation` are optional on every agent-facing command:
// the CLI works out which session is calling it (see session-owner.mjs). They
// stay accepted because an adapter, a script, or an agent holding a session id
// from `acc status --json` has a reason to be explicit. They remain required on
// attach, heartbeat and detach, which are the adapter's own lifecycle calls.
export const COMMANDS = Object.freeze({
  attach: { required: ["participant"], optional: ["harness", "cadence", "parent", "session"] },
  heartbeat: { required: ["session", "generation"], optional: [] },
  detach: { required: ["session", "generation"], optional: [] },
  sync: { required: [], optional: ["session", "cursor", "limit", "scope"] },
  work: { required: [], optional: ["session", "generation", "summary", "mode",
    "state", "workstream"], repeated: ["hint"], flags: ["clear"] },
  claim: { required: ["resource"],
    optional: ["session", "generation", "mode", "enforcement", "reason", "lease"] },
  release: { required: ["claim"],
    optional: ["session", "generation", "authority", "reason"] },
  message: { required: ["subject", "body"],
    optional: ["session", "generation", "type", "priority", "workstream"],
    repeated: ["to"], flags: ["requires-ack"] },
  // Asking another agent to do something: one call, because a task nobody was
  // told about and a message pointing at no task are each useless.
  request: { required: ["to", "title"],
    optional: ["session", "generation", "detail", "workstream", "priority"],
    repeated: ["depends-on"] },
  // Create a task, or act on one with --task. A workstream is optional: small
  // requests should not have to invent a project first.
  task: { required: [], optional: ["session", "generation", "workstream", "title",
    "detail", "assignee", "state", "task", "reason"],
    repeated: ["depends-on"], flags: ["take", "decline", "force"] },
  workstream: { required: ["title", "objective"], optional: ["session", "generation"] },
  // Messages not tied to a task need a way to be answered too. Without one a
  // `requiresAck` message raised an attention item nothing could ever clear.
  ack: { required: ["message"], optional: ["session", "generation", "state"] },
  finish: { required: ["goal"], optional: ["session", "generation", "status", "to"],
    repeated: ["completed", "remaining", "blocker"] },
  status: { required: [], optional: ["participant"] },
  doctor: { required: [], optional: ["home"], flags: ["repair"] },
  // The one command with a subcommand. Kept as an explicit list rather than a
  // free positional: `acc config delete` should fail at the parser, not deep
  // inside a handler that has already decided what to do.
  config: { required: [], optional: [], flags: ["yes", "force"],
    subcommands: ["init", "validate"] },
  install: { required: [], optional: ["adapter", "home"], flags: ["dry-run", "yes"] },
  uninstall: { required: [], optional: ["adapter", "home"], flags: ["yes"] },
});

const GLOBAL = Object.freeze(["json", "workspace", "cwd"]);

function usage(message, details = {}) {
  throw new AccError(EXIT.USAGE, message, details);
}

const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) usage("a command is required");
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (spec === undefined) usage(`unknown command: ${command}`, { command });

  let tokens = rest;
  let subcommand;
  if (spec.subcommands !== undefined) {
    [subcommand, ...tokens] = rest;
    if (subcommand === undefined || !spec.subcommands.includes(subcommand)) {
      usage(`${command} requires one of: ${spec.subcommands.join(", ")}`,
        { command, subcommand: subcommand ?? null });
    }
  }

  const repeated = new Set(spec.repeated ?? []);
  const flags = new Set([...(spec.flags ?? []), "json"]);
  const known = new Set([...(spec.required ?? []), ...(spec.optional ?? []),
    ...repeated, ...(spec.flags ?? []), ...GLOBAL]);
  const options = {};

  // Free-text values legitimately start with "--": a message body carrying a
  // diff begins "--- a/file", and agents exchanging evidence is the point of
  // this tool. So a following token is only treated as a missing value when it
  // names a real option of this command, which still catches the actual typo
  // (--subject --body x). --name=value is the unambiguous form for the rest.
  const looksLikeOption = value => typeof value === "string" && value.startsWith("--")
    && known.has(value.slice(2).split("=", 1)[0]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--") || token.length === 2) usage(`unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    const name = separator === -1 ? token.slice(2) : token.slice(2, separator);
    const inline = separator === -1 ? undefined : token.slice(separator + 1);
    if (!known.has(name)) usage(`unknown option for ${command}: --${name}`, { command, name });
    const key = camel(name);

    if (flags.has(name)) {
      if (inline !== undefined) usage(`option --${name} does not take a value`);
      if (Object.hasOwn(options, key)) usage(`option --${name} may be used only once`);
      options[key] = true;
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = tokens[index + 1];
      if (next === undefined || looksLikeOption(next)) {
        usage(`option --${name} requires a value`);
      }
      value = next;
      index += 1;
    }
    if (value === "") usage(`option --${name} requires a value`);
    if (repeated.has(name)) (options[key] ??= []).push(value);
    else if (Object.hasOwn(options, key)) usage(`option --${name} may be used only once`);
    else options[key] = value;
  }

  for (const name of spec.required ?? []) {
    if (!Object.hasOwn(options, camel(name))) {
      usage(`${command} requires --${name}`, { command, option: name });
    }
  }
  return { command, options: subcommand === undefined ? options : { ...options, subcommand } };
}

export function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    usage(`--${name} must be a positive number`, { value });
  }
  return parsed;
}
