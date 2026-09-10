import { AccError, EXIT } from "@agents-can-communicate/protocol";

export const unsafe = (reason = "unrecognized TOML declaration") => {
  throw new AccError(EXIT.CONFLICT, `cannot safely edit Codex config: ${reason}; `
    + "repair ambiguous TOML or ACC markers before retrying", { reason });
};
// A bounded lexical scan, not a TOML value parser. Newlines inside strings,
// arrays and inline tables cannot introduce a header or a managed marker.
export function* statements(source) {
  let start = 0, code = "", quote = null;
  const stack = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (quote) {
      if (quote[0] === '"' && char === "\\") {
        code += source.slice(i, i + 2); i += 2; continue;
      }
      if (source.startsWith(quote, i)) {
        let count = quote.length;
        if (quote.length === 3) {
          while (source[i + count] === quote[0]) count++;
          if (count > 5) unsafe("unsupported string quote delimiter");
        }
        code += source.slice(i, i + count); i += count; quote = null; continue;
      }
      if (quote.length === 1 && /[\r\n]/.test(char)) unsafe("newline in single-line string");
      code += char; i++; continue;
    }
    if (char === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = source.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      code += quote; i += quote.length; continue;
    }
    if (char === "[" || char === "{") stack.push(char);
    if (char === "]" || char === "}") {
      if (stack.pop() !== (char === "]" ? "[" : "{")) unsafe("mismatched collection delimiter");
    }
    code += char; i++;
    if (char === "\n" && stack.length === 0) {
      yield { raw: source.slice(start, i), code: code.trim(), start, end: i };
      start = i; code = "";
    }
  }
  if (quote || stack.length) unsafe(quote ? "unclosed string" : "unclosed collection");
  if (start < source.length) yield { raw: source.slice(start), code: code.trim(), start, end: source.length };
}

function decodeKey(key) {
  if (key[0] === "'") return key.slice(1, -1);
  if (key[0] !== '"') return key;
  return key.slice(1, -1).replace(/\\(U[\da-fA-F]{8}|u[\da-fA-F]{4}|[btnfr"\\])|\\./g,
    (match, escape) => {
      if (!escape) unsafe("unsupported quoted-key escape");
      if (/^[uU]/.test(escape)) {
        const point = Number.parseInt(escape.slice(1), 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
          unsafe("invalid quoted-key Unicode escape");
        }
        return String.fromCodePoint(point);
      }
      return ({ b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" })[escape];
    });
}

function keyPath(code) {
  const keys = [];
  let rest = code.trimStart();
  for (;;) {
    const match = /^(?:[A-Za-z0-9_-]+|'[^'\r\n]*'|"(?:[^"\\\r\n]|\\[^\r\n])*")/.exec(rest);
    if (!match) unsafe("unrecognized TOML key");
    keys.push(decodeKey(match[0]));
    rest = rest.slice(match[0].length).trimStart();
    if (!rest.startsWith(".")) return { keys, rest };
    rest = rest.slice(1).trimStart();
  }
}

export function declaration(code) {
  const header = code.startsWith("[");
  const array = header && code.startsWith("[[");
  const { keys, rest } = keyPath(header ? code.slice(array ? 2 : 1) : code);
  if (header ? rest !== (array ? "]]" : "]") : !rest.startsWith("=")) unsafe();
  return { keys, header, array, value: header ? null : rest.slice(1).trim() };
}

// Resolved declaration paths are only structural facts, never parsed user values.
export function scanConfig(source) {
  let table = [];
  return [...statements(source)].map(item => {
    if (!item.code) return { ...item, table: [...table], keys: [] };
    const entry = declaration(item.code);
    if (entry.header) table = entry.keys;
    return { ...item, ...entry, table: [...table],
      keys: entry.header ? entry.keys : [...table, ...entry.keys] };
  });
}
