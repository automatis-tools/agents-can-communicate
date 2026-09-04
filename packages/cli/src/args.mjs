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
    "state"], repeated: ["hint"], flags: ["clear"] },
  claim: { required: ["resource"],
    optional: ["session", "generation", "mode", "enforcement", "reason", "lease"] },
  // Neither is required on its own, because either one names the claim: an id
  // is precise, and a resource is what the caller typed to take it in the first
  // place. Requiring the id meant a round trip through `acc status --json` to
  // look up something the caller never chose.
  release: { required: [],
    optional: ["claim", "resource", "session", "generation", "authority", "reason"] },
  message: { required: ["subject", "body"],
    optional: ["session", "generation", "type", "obligation", "client-message-id"],
    repeated: ["to"] },
  inbox: { required: [], optional: ["session", "generation", "message"] },
  reply: { required: ["message", "body"],
    optional: ["session", "generation", "subject", "client-message-id"] },
  // Asking another agent to do something as a message with a reply obligation.
  request: { required: ["to", "title"],
    optional: ["session", "generation", "detail", "client-message-id"] },
  ack: { required: ["message"], optional: ["session", "generation"] },
  finish: { required: ["goal"], optional: ["session", "generation", "status", "to",
    "client-message-id"],
    repeated: ["completed", "remaining", "blocker"] },
  status: { required: [], optional: ["participant"], flags: ["all"] },
  doctor: { required: [], optional: ["home"], flags: ["repair"] },
  // The one command with a subcommand. Kept as an explicit list rather than a
  // free positional: `acc config delete` should fail at the parser, not deep
  // inside a handler that has already decided what to do.
  config: { required: [], optional: [], flags: ["yes", "force"],
    subcommands: ["init", "validate"] },
  // No `--yes`: neither of these ever asked, so the flag agreed to nothing. It
  // was accepted and read by nobody, which is a promise that a confirmation
  // exists to be skipped.
  // `--downgrade` because an older acc first on PATH will otherwise rewire every
  // client to itself, and the only symptom is a guard behaving like the version
  // it came from.
  install: { required: [], optional: ["home", "delivery"], repeated: ["adapter"],
    flags: ["dry-run", "downgrade"] },
  // `--dry-run` on both, because the preview was computed for either action and
  // only `install` could ask for it. Removal is the side that reaches into a
  // client's configuration - including a client that has left the machine.
  uninstall: { required: [], optional: ["home"], repeated: ["adapter"], flags: ["dry-run"] },
  // Asking npm whether there is a newer ACC. The one command that touches the
  // network, and never on the hook path.
  update: { required: [], optional: [], flags: ["apply"] },
  // The two things a person types first after installing from a registry. The
  // CLI answered neither: `acc --version` and `acc --help` were both "unknown
  // command", and `acc` on its own asked for a command without naming one.
  help: { required: [], optional: [] },
  version: { required: [], optional: [] },
});

// Spelled as the commands they mean, and only in first position. A message body
// legitimately begins with "--" - exchanging diffs is the point of this tool -
// so reading them anywhere in the argv would make `acc message --body "--help"`
// print the help instead of sending it.
const ALIASES = Object.freeze({ "--help": "help", "-h": "help",
  "--version": "version", "-v": "version", "-V": "version" });

const GLOBAL = Object.freeze(["json", "workspace", "cwd"]);

function usage(message, details = {}) {
  throw new AccError(EXIT.USAGE, message, details);
}

const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    usage("a command is required - `acc help` lists them");
  }
  const [first, ...rest] = argv;
  const command = ALIASES[first] ?? first;
  const spec = COMMANDS[command];
  if (spec === undefined) {
    usage(`unknown command: ${command} - \`acc help\` lists them`, { command });
  }

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
