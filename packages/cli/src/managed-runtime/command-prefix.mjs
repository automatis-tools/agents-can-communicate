// Shared with CLI parsing, but dependency-free: immutable launchers cannot load
// workspace modules before runtime admission. Consume values, never search for
// command words that might appear inside a path or a message.
export const GLOBAL_OPTIONS = Object.freeze(["json", "workspace", "cwd"]);

export function commandPrefix(argv) {
  const leading = [];
  let offset = 0;
  while (offset < argv.length) {
    const token = argv[offset];
    const name = token.startsWith("--") ? token.slice(2).split("=", 1)[0] : "";
    if (!GLOBAL_OPTIONS.includes(name)) break;
    leading.push(token);
    offset += 1;
    if (name !== "json" && !token.includes("=")) {
      const value = argv[offset];
      if (value === undefined || value.startsWith("--")
        && GLOBAL_OPTIONS.includes(value.slice(2).split("=", 1)[0])) {
        return { error: `option --${name} requires a value` };
      }
      leading.push(value);
      offset += 1;
    }
  }
  return { command: argv[offset], leading, rest: argv.slice(offset + 1) };
}
