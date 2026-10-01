// The owner header a hook hands its model, read back the way a shell reads it.
// POSIX quotes each value in single quotes (`'\''` for a quote inside); Windows
// uses double quotes, or single quotes for a value a double-quoting shell would
// expand (packages/hook-runner/src/owner-context.mjs).

/** Shell words, with adjacent quoted and bare parts joined as sh joins them. */
export function shellWords(text) {
  const words = [];
  let word = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word ??= "";
    // Outside quotes a backslash takes the next character as it is: `'\''`.
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      word += text[index];
      continue;
    }
    // Inside either quote the text is literal: POSIX single quotes, and the
    // Windows double quotes that hold a path with its backslashes as they are.
    if (char === "'" || char === '"') {
      const end = text.indexOf(char, index + 1);
      if (end === -1) throw new Error(`unterminated ${char} in ${text}`);
      word += text.slice(index + 1, end);
      index = end;
      continue;
    }
    word += char;
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * `{ line, session, generation, cwd, workspace }` from hook output that carries
 * an `ACC CLI (append):` line, or null when it carries none. `line` is what
 * follows the prefix: the text a model appends to its command.
 */
export function parseOwnerHeader(context) {
  const match = /^ACC CLI \(append\): (.+)$/m.exec(context);
  if (match === null) return null;
  const words = shellWords(match[1]);
  const value = flag => {
    const at = words.indexOf(flag);
    return at === -1 ? undefined : words[at + 1];
  };
  return { line: match[1], session: value("--session"), generation: value("--generation"),
    cwd: value("--cwd"), workspace: value("--workspace") };
}
