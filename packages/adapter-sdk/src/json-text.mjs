/**
 * Edit a JSON document as text, so what was not changed is not rewritten.
 *
 * `JSON.parse` then `JSON.stringify` re-emits every byte of a file, which
 * reformats the parts ACC was not asked to touch: a nested object a person kept
 * on one line comes back as three, and a blank line between sections is gone.
 * The bytes are the user's, and a tool that edits their settings should leave a
 * diff of what it changed rather than of how it prints.
 *
 * So the original text is kept and spliced. Anything whose value is unchanged is
 * copied across verbatim - not re-serialised and hoped to match - and only a
 * member that was added, removed or replaced is written fresh.
 *
 * The result is parsed back and compared to the value it was asked to write. A
 * splice that would change meaning is discarded rather than written, and the
 * caller falls back to plain `JSON.stringify`: the worst this can do is what
 * was already being done.
 */

const WHITESPACE = " \t\n\r";
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const isObject = value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Read a JSON document into a tree that remembers where everything was.
 *
 * @returns the root node, or null for anything this cannot read - which the
 * caller treats the same way as a file it must not touch.
 */
export function readJson(text) {
  if (typeof text !== "string") return null;
  let at = 0;

  const skip = () => { while (at < text.length && WHITESPACE.includes(text[at])) at += 1; };
  const fail = () => { throw new SyntaxError(`unreadable JSON at ${at}`); };
  const expect = character => { if (text[at] !== character) fail(); at += 1; };

  const readString = () => {
    expect('"');
    while (at < text.length) {
      if (text[at] === "\\") { at += 2; continue; }
      if (text[at] === '"') { at += 1; return; }
      at += 1;
    }
    fail();
  };

  const readValue = () => {
    skip();
    const start = at;
    if (text[at] === "{") return readObject(start);
    if (text[at] === "[") return readArray(start);
    if (text[at] === '"') { readString(); }
    else {
      // Numbers, true, false, null: read to the next structural character and
      // let `JSON.parse` below be the judge of what was read.
      while (at < text.length && !",}]".includes(text[at]) && !WHITESPACE.includes(text[at])) {
        at += 1;
      }
      if (at === start) fail();
    }
    const slice = text.slice(start, at);
    return { kind: "scalar", start, end: at, value: JSON.parse(slice) };
  };

  function readObject(start) {
    expect("{");
    const members = [];
    const value = {};
    for (;;) {
      // Everything between the previous member and this one - the comma, the
      // newline, the indentation - is kept as it was written.
      const gapStart = at;
      skip();
      if (text[at] === "}") { at += 1; break; }
      if (members.length > 0) { expect(","); skip(); }
      if (text[at] === "}") { at += 1; break; }
      const keyStart = at;
      readString();
      const key = JSON.parse(text.slice(keyStart, at));
      skip();
      expect(":");
      const node = readValue();
      members.push({ key, gapStart, keyStart, valueStart: node.start, end: node.end, node });
      // Defined rather than assigned: `value.__proto__ = …` sets the prototype
      // of an ordinary object instead of adding a key to it, so a config with
      // that key read back without it - and the comparison that decides whether
      // a subtree changed would be answering about a different document than
      // the one on disk. This is what `JSON.parse` does with the same input.
      Object.defineProperty(value, key,
        { value: node.value, writable: true, enumerable: true, configurable: true });
    }
    return { kind: "object", start, end: at, value, members };
  }

  function readArray(start) {
    expect("[");
    const items = [];
    const value = [];
    for (;;) {
      skip();
      if (text[at] === "]") { at += 1; break; }
      if (items.length > 0) { expect(","); skip(); }
      if (text[at] === "]") { at += 1; break; }
      const node = readValue();
      items.push(node);
      value.push(node.value);
    }
    return { kind: "array", start, end: at, value, items };
  }

  try {
    const root = readValue();
    skip();
    // Trailing content means this is not the document it appears to be.
    return at === text.length ? root : null;
  } catch {
    return null;
  }
}

/**
 * Write `value` into `text`, changing only what differs.
 *
 * @returns the edited document, or null when it cannot be done safely - an
 * unreadable original, or a splice that came back meaning something else.
 */
export function editJson(text, value, indent) {
  const root = readJson(text);
  if (root === null) return null;

  const unit = typeof indent === "number" ? " ".repeat(indent) : (indent ?? "  ");
  const pad = depth => unit.repeat(depth);
  const broken = unit !== "";

  // A value with no original to preserve: printed the way this file prints,
  // then moved to the depth it sits at.
  const fresh = (subject, depth) => {
    const printed = JSON.stringify(subject, null, unit);
    return broken ? printed.split("\n").join(`\n${pad(depth)}`) : printed;
  };

  const render = (node, subject, depth) => {
    if (node !== null && same(node.value, subject)) return text.slice(node.start, node.end);
    if (node?.kind === "object" && isObject(subject)) return spliceObject(node, subject, depth);
    return fresh(subject, depth);
  };

  function spliceObject(node, subject, depth) {
    const byKey = new Map(node.members.map(member => [member.key, member]));
    const pieces = [];

    for (const key of Object.keys(subject)) {
      const member = byKey.get(key);
      if (member === undefined) {
        // New: written in this file's own shape rather than copied from nowhere.
        pieces.push(broken
          ? `\n${pad(depth + 1)}${JSON.stringify(key)}: ${fresh(subject[key], depth + 1)}`
          : `${JSON.stringify(key)}:${fresh(subject[key], depth + 1)}`);
        continue;
      }
      // The separator that preceded it, the key as it was spelled, and the
      // colon and spacing after it: all of it is the user's, and none of it is
      // what changed.
      const separator = text.slice(member.gapStart, member.keyStart);
      const label = text.slice(member.keyStart, member.valueStart);
      pieces.push(separator.replace(",", "") + label + render(member.node, subject[key], depth + 1));
    }

    // The comma belongs between members, so it is placed rather than copied:
    // a member that used to be first no longer is, and one that is now first
    // must not arrive with the comma it used to carry.
    const body = pieces.join(",");
    // What sat between the last member and the brace, when the last member is
    // still the one that was there; otherwise this file's own closing shape.
    const last = node.members.at(-1);
    const closing = last !== undefined && Object.keys(subject).at(-1) === last.key
      ? text.slice(last.end, node.end - 1)
      : (broken ? `\n${pad(depth)}` : "");
    if (pieces.length === 0) return "{}";
    return `{${body}${closing}}`;
  }

  const edited = render(root, value, 0);
  // The safety net. A splice that parses to something else is not written.
  let read;
  try {
    read = JSON.parse(edited);
  } catch {
    return null;
  }
  return same(read, value) ? edited : null;
}
