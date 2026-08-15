import { CommsError, EXIT } from "./errors.mjs";

const COMMANDS = Object.freeze({
  init: { optional: ["json"] },
  prompt: { required: ["id", "role", "task"], repeated: ["ownership"] },
  register: { required: ["id", "role", "task"], repeated: ["ownership"], flags: ["resume"],
    optional: ["client", "json"] },
  close: { required: ["id"], optional: ["json"] },
  send: messageSpec(["from", "to"]),
  broadcast: { required: ["from", "severity", "subject"], optional: ["body", "body-file", "json"],
    repeated: ["attachment", "ephemeral-attachment"], flags: ["requires-ack"] },
  inbox: { required: ["id"], repeated: ["type", "severity"], optional: ["json"] },
  ack: { required: ["id", "message"], optional: ["json"] },
  reply: messageSpec(["from", "message"]),
  watch: { required: ["id"], optional: ["heartbeat", "scan-interval"] },
  wait: { required: ["id"], optional: ["timeout", "scan-interval", "json"] },
  claim: { required: ["id", "scope", "reason"], optional: ["lease", "json"] },
  release: { required: ["id", "scope"], flags: ["force-stale"], optional: ["owner", "json"] },
  handoff: { required: ["id", "to", "task", "result", "branch", "base", "verification-file",
    "contracts-file", "limitations-file"], optional: ["commit", "json"], flags: ["uncommitted"],
  repeated: ["changed", "follow-up", "artifact", "ephemeral-artifact"] },
  status: { flags: ["fail-on-stale", "fail-on-pending"], optional: ["json"] },
  doctor: { repeated: ["require-live"], flags: ["repair"], optional: ["json"] },
});

function messageSpec(required) {
  return { required: [...required, "type", "severity", "subject"], optional: ["body", "body-file", "json"],
    repeated: ["attachment", "ephemeral-attachment"], flags: ["requires-ack"] };
}

function usage(message) { throw new CommsError(message, EXIT.USAGE); }
export function errorPayload(error, exitCode) { return { error: {
  message: error instanceof CommsError ? error.message : error.stack, exit_code: exitCode,
  details: error instanceof CommsError ? error.details : null } }; }
function keyFor(option) {
  return option.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function allNames(spec) {
  return new Set([...(spec.required ?? []), ...(spec.optional ?? []), ...(spec.repeated ?? []),
    ...(spec.flags ?? [])]);
}

function addOption(options, spec, name, value) {
  const key = keyFor(name);
  if ((spec.repeated ?? []).includes(name)) {
    (options[key] ??= []).push(value);
    return;
  }
  if (Object.hasOwn(options, key)) usage(`option --${name} may be used only once`);
  options[key] = value;
}

function validate(spec, command, options) {
  for (const name of spec.required ?? []) {
    if (!Object.hasOwn(options, keyFor(name))) usage(`${command} requires --${name}`);
  }
  if (["send", "reply", "broadcast"].includes(command)) {
    const sources = ["body", "bodyFile"].filter(key => Object.hasOwn(options, key));
    if (sources.length > 1) usage(`${command} accepts exactly one of --body, --body-file, or stdin`);
  }
  if (command === "prompt" && (!Array.isArray(options.ownership) || options.ownership.length === 0
    || options.ownership.some(value => value.trim().length === 0))) {
    usage("prompt requires every --ownership to contain non-whitespace content");
  }
  if (command === "release" && options.forceStale && !Object.hasOwn(options, "owner")) {
    usage("release --force-stale requires --owner");
  }
  if (command === "handoff" && !options.uncommitted && !Object.hasOwn(options, "commit")) {
    usage("handoff requires --commit unless --uncommitted is set");
  }
  if (command === "handoff" && options.uncommitted && Object.hasOwn(options, "commit")) {
    usage("handoff --uncommitted cannot include --commit");
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) usage("a command is required");
  const [command, ...tokens] = argv;
  const spec = COMMANDS[command];
  if (spec === undefined) usage(`unknown command: ${command}`);
  const known = allNames(spec);
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--") || token.length === 2) usage(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!known.has(name)) usage(`unknown option for ${command}: --${name}`);
    if ((spec.flags ?? []).includes(name) || name === "json") {
      const key = keyFor(name);
      if (Object.hasOwn(options, key)) usage(`option --${name} may be used only once`);
      options[key] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`option --${name} requires a value`);
    addOption(options, spec, name, value);
    index += 1;
  }
  validate(spec, command, options);
  return { command, options };
}
