import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Commands the model is offered stay few and high level; attach, heartbeat, and
// detach exist for adapters and are deliberately not advertised as model tools.
export const COMMANDS = Object.freeze({
  attach: { required: ["participant"], optional: ["harness", "cadence", "parent", "session"] },
  heartbeat: { required: ["session", "generation"], optional: [] },
  detach: { required: ["session", "generation"], optional: [] },
  sync: { required: [], optional: ["session", "cursor", "limit", "scope"] },
  work: { required: ["session", "generation", "summary"],
    optional: ["mode", "state", "workstream"], repeated: ["hint"] },
  claim: { required: ["session", "generation", "resource"],
    optional: ["mode", "enforcement", "reason", "lease"] },
  release: { required: ["session", "generation", "claim"],
    optional: ["authority", "reason"] },
  message: { required: ["session", "generation", "subject", "body"],
    optional: ["type", "priority", "workstream"], repeated: ["to"],
    flags: ["requires-ack"] },
  task: { required: ["session", "generation", "workstream", "title"],
    optional: ["state", "task"], repeated: ["depends-on"] },
  finish: { required: ["session", "generation", "goal"],
    optional: ["status", "to"], repeated: ["completed", "remaining", "blocker"] },
  status: { required: [], optional: ["participant"] },
  doctor: { required: [], optional: [], flags: ["repair"] },
});

const GLOBAL = Object.freeze(["json", "workspace", "cwd"]);

function usage(message, details = {}) {
  throw new AccError(EXIT.USAGE, message, details);
}

const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) usage("a command is required");
  const [command, ...tokens] = argv;
  const spec = COMMANDS[command];
  if (spec === undefined) usage(`unknown command: ${command}`, { command });

  const repeated = new Set(spec.repeated ?? []);
  const flags = new Set([...(spec.flags ?? []), "json"]);
  const known = new Set([...(spec.required ?? []), ...(spec.optional ?? []),
    ...repeated, ...(spec.flags ?? []), ...GLOBAL]);
  const options = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--") || token.length === 2) usage(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!known.has(name)) usage(`unknown option for ${command}: --${name}`, { command, name });
    const key = camel(name);
    if (flags.has(name)) {
      if (Object.hasOwn(options, key)) usage(`option --${name} may be used only once`);
      options[key] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`option --${name} requires a value`);
    if (repeated.has(name)) (options[key] ??= []).push(value);
    else if (Object.hasOwn(options, key)) usage(`option --${name} may be used only once`);
    else options[key] = value;
    index += 1;
  }

  for (const name of spec.required ?? []) {
    if (!Object.hasOwn(options, camel(name))) {
      usage(`${command} requires --${name}`, { command, option: name });
    }
  }
  return { command, options };
}

export function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    usage(`--${name} must be a positive number`, { value });
  }
  return parsed;
}
