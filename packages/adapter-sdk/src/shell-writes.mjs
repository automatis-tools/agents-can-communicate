/**
 * What a shell command would write.
 *
 * The guard used to declare no targets for a shell call at all, on the reasoning
 * that a command can write anywhere and a guessed path is wrong in both
 * directions. That reasoning held until agents started being told to prefer the
 * shell for file edits: a claim that any `printf >> file` walks through is not a
 * claim. The answer is not to guess. It is to read the positions where a write
 * is unambiguous - a redirection, the operand of a command whose whole job is to
 * put bytes somewhere - and to stay silent everywhere else.
 *
 * Two properties matter more than coverage:
 *
 *   - A read is never reported. `cat file` and `grep file` name a path in an
 *     argument position that writes nothing; treating those as writes would have
 *     sessions blocking each other for looking.
 *   - It never throws. This runs on the hook path inside a budget that fails
 *     open, so an unparseable command yields no targets rather than an error.
 *
 * What it does not see is stated where a person reads it (`context-projector`):
 * a language runtime opening a file, an `eval`, a command built at runtime. A
 * shell can still evade this. Partial sight is not the same as none - today
 * every one of these walks through - and an agent told where the guard ends
 * behaves better than one who believes it absolute.
 */

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "\n"]);

// Redirections that write. `<` and `<<` read; `>&`/`<&` duplicate a descriptor
// and name no file.
const WRITE_REDIRECTION = /^(?:[0-9]*|&)(?:>>|>\|?)$/;

// Sinks that discard. Naming one is not touching a file anybody claims.
const NOT_A_FILE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/**
 * How each command spends its operands.
 *
 * `pick` decides which operands are written: every one, only the last (a
 * destination), or every one but the first (a script that is not a file).
 * `valueFlags` are the flags whose following token is a value rather than a
 * path - without them, `truncate -s 0 file` would report a file named `0`.
 */
const WRITERS = new Map(Object.entries({
  tee: { pick: "all" },
  touch: { pick: "all", valueFlags: new Set(["-d", "-r", "-t", "--date", "--reference"]) },
  truncate: { pick: "all", valueFlags: new Set(["-s", "--size", "-r", "--reference"]) },
  rm: { pick: "all" },
  unlink: { pick: "all" },
  shred: { pick: "all", valueFlags: new Set(["-n", "--iterations", "-s", "--size"]) },
  mkdir: { pick: "all", valueFlags: new Set(["-m", "--mode"]) },
  rmdir: { pick: "all" },
  cp: { pick: "last", valueFlags: new Set(["-t", "--target-directory", "-S", "--suffix"]) },
  install: { pick: "last", valueFlags: new Set(["-t", "--target-directory", "-m", "-o", "-g"]) },
  rsync: { pick: "last", valueFlags: new Set(["-e", "--rsh", "--exclude"]) },
  ln: { pick: "last", valueFlags: new Set(["-t", "--target-directory", "-S", "--suffix"]) },
  // A move writes the destination and empties the source. Both are the peer's
  // business, so both are reported.
  mv: { pick: "all", valueFlags: new Set(["-t", "--target-directory", "-S", "--suffix"]) },
}));

// In-place editors: a write only when the in-place flag is present, and their
// script operand is never a file.
const IN_PLACE = new Map(Object.entries({
  sed: { valueFlags: new Set(["-e", "--expression", "-f", "--file", "-l", "-E"]) },
  perl: { valueFlags: new Set(["-e", "-E", "-M", "-m"]) },
  ruby: { valueFlags: new Set(["-e", "-r"]) },
}));

/**
 * Split a command line into tokens, keeping quoted text out of the grammar.
 *
 * Returns null on anything it cannot read - an unterminated quote, most often -
 * which the caller turns into "no targets" rather than a guess.
 */
function tokenize(command) {
  const tokens = [];
  let text = "";
  let started = false;
  let quoted = false;

  const flush = () => {
    if (started) tokens.push({ text, quoted });
    text = "";
    started = false;
    quoted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (character === "\\") {
      const next = command[index + 1];
      if (next === undefined) return null;
      text += next;
      started = true;
      quoted = true;
      index += 1;
      continue;
    }

    if (character === "'" || character === '"') {
      const close = command.indexOf(character, index + 1);
      if (close === -1) return null;
      text += command.slice(index + 1, close);
      started = true;
      quoted = true;
      index = close;
      continue;
    }

    if (character === " " || character === "\t") {
      flush();
      continue;
    }

    if (character === "\n") {
      flush();
      tokens.push({ operator: "\n" });
      continue;
    }

    if (character === ";" || character === "&" || character === "|" || character === ">"
      || character === "<") {
      // A redirection may carry its descriptor on the front (`2>`), which is
      // already sitting in `text` unquoted.
      const prefix = !quoted && /^[0-9]+$/.test(text) ? text : null;
      if (prefix === null) flush();
      else { text = ""; started = false; }

      let operator = character;
      while (index + 1 < command.length && "&|<>".includes(command[index + 1])) {
        operator += command[index + 1];
        index += 1;
      }
      tokens.push({ operator: prefix === null ? operator : prefix + operator });
      continue;
    }

    text += character;
    started = true;
  }
  flush();
  return tokens;
}

/** Break a token list at the separators, so every simple command is read. */
function simpleCommands(tokens) {
  const commands = [[]];
  for (const token of tokens) {
    if (token.operator !== undefined && SEPARATORS.has(token.operator)) commands.push([]);
    else commands.at(-1).push(token);
  }
  return commands.filter(command => command.length > 0);
}

/**
 * Drop heredoc bodies.
 *
 * The body is content the shell never parses, and it is exactly where a `>` or
 * an `rm` is most likely to appear innocently. Reading it would invent targets
 * out of a file's own text.
 */
function stripHeredocs(command) {
  const pattern = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let result = command;
  for (;;) {
    pattern.lastIndex = 0;
    const opener = pattern.exec(result);
    if (opener === null) return result;
    const lineEnd = result.indexOf("\n", opener.index);
    if (lineEnd === -1) return result.slice(0, opener.index) + result.slice(opener.index).replace(pattern, "");
    const terminator = new RegExp(`^\\s*${opener[2]}\\s*$`, "m");
    const rest = result.slice(lineEnd + 1);
    const end = terminator.exec(rest);
    const body = end === null ? rest.length : end.index + end[0].length;
    result = result.slice(0, opener.index) + result.slice(opener.index, lineEnd).replace(pattern, "")
      + "\n" + rest.slice(body);
  }
}

/** The word a redirection writes to, or null when it names no file. */
function redirectionTarget(tokens, index) {
  const next = tokens[index + 1];
  if (next === undefined || next.operator !== undefined) return null;
  if (next.text.startsWith("&")) return null;
  return NOT_A_FILE.has(next.text) ? null : next.text;
}

/** Operands of a simple command, with flags and their values removed. */
function operandsOf(words, valueFlags = new Set()) {
  const operands = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word.quoted && word.text.startsWith("-") && word.text !== "-") {
      if (valueFlags.has(word.text)) index += 1;
      continue;
    }
    operands.push(word.text);
  }
  return operands;
}

/** Strip the leading environment assignments and wrappers off a command. */
function commandWords(words) {
  let start = 0;
  while (start < words.length) {
    const word = words[start];
    if (word.operator !== undefined) return null;
    if (!word.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)) { start += 1; continue; }
    if (["sudo", "command", "nohup", "time", "nice"].includes(word.text)) { start += 1; continue; }
    if (word.text === "env") { start += 1; continue; }
    break;
  }
  return start >= words.length ? null : words.slice(start);
}

/** Targets a `dd` call writes, which it names as `of=`. */
function ddTargets(words) {
  return words.slice(1)
    .filter(word => word.text.startsWith("of="))
    .map(word => word.text.slice(3))
    .filter(target => target !== "" && !NOT_A_FILE.has(target));
}

/**
 * Targets a `git` call writes into the working tree.
 *
 * Only the two that overwrite a file a peer may be holding. `git log -- path`
 * and `git diff path` name the same path and touch nothing, which is why the
 * subcommand is read before the operands.
 */
function gitTargets(words) {
  const subcommand = words[1]?.text;
  if (subcommand === "restore") {
    return operandsOf(words.slice(1), new Set(["--source", "-s"]));
  }
  if (subcommand === "checkout") {
    const separator = words.findIndex(word => word.text === "--" && !word.quoted);
    if (separator === -1) return [];
    return words.slice(separator + 1).map(word => word.text);
  }
  return [];
}

/** Targets of an in-place editor, whose script operand is not a file. */
function inPlaceTargets(words, spec) {
  const flags = words.slice(1).filter(word => !word.quoted && word.text.startsWith("-"));
  const inPlace = flags.some(word => word.text === "-i" || word.text.startsWith("-i")
    || word.text === "--in-place" || word.text.startsWith("--in-place="));
  if (!inPlace) return [];

  const valueFlags = new Set(spec.valueFlags);
  const operands = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!word.quoted && word.text.startsWith("-") && word.text !== "-") {
      // `-i ''` on BSD takes its suffix as a separate word; a cluster carrying
      // `e` takes the script that follows it.
      if (valueFlags.has(word.text)) index += 1;
      else if (/^-[A-Za-z]*[eEf]$/.test(word.text)) index += 1;
      else if (word.text === "-i" && words[index + 1]?.quoted
        && (words[index + 1].text === "" || words[index + 1].text.startsWith("."))) index += 1;
      continue;
    }
    operands.push(word.text);
  }

  const scriptGiven = flags.some(word => /^-[A-Za-z]*[eEf]$/.test(word.text)
    || word.text.startsWith("--expression") || word.text.startsWith("--file"));
  return scriptGiven ? operands : operands.slice(1);
}

/**
 * Paths a shell command would write.
 *
 * Order is the order they appear; a path named twice is reported once. Anything
 * unreadable yields an empty list.
 */
export function shellWriteTargets(command) {
  if (typeof command !== "string" || command.trim() === "") return [];

  let targets = [];
  try {
    const tokens = tokenize(stripHeredocs(command));
    if (tokens === null) return [];

    for (const simple of simpleCommands(tokens)) {
      for (let index = 0; index < simple.length; index += 1) {
        const token = simple[index];
        if (token.operator === undefined || !WRITE_REDIRECTION.test(token.operator)) continue;
        const target = redirectionTarget(simple, index);
        if (target !== null) targets.push(target);
      }

      const words = commandWords(simple.filter(token => token.operator === undefined));
      if (words === null || words.length === 0) continue;
      const name = words[0].text.split("/").at(-1);

      if (name === "dd") { targets.push(...ddTargets(words)); continue; }
      if (name === "git") { targets.push(...gitTargets(words)); continue; }

      const inPlace = IN_PLACE.get(name);
      if (inPlace !== undefined) { targets.push(...inPlaceTargets(words, inPlace)); continue; }

      const writer = WRITERS.get(name);
      if (writer === undefined) continue;
      const operands = operandsOf(words, writer.valueFlags);
      if (operands.length === 0) continue;
      targets.push(...(writer.pick === "last" ? operands.slice(-1) : operands));
    }
  } catch {
    // The hook path fails open. A command this cannot read is a command it
    // reports nothing about.
    return [];
  }

  return [...new Set(targets.filter(target => target !== "" && !NOT_A_FILE.has(target)))];
}
