import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BEGIN, END, renderBlock } from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

const unsafe = () => {
  throw new AccError(EXIT.CONFLICT, "cannot safely edit Codex config; "
    + "repair ambiguous TOML or ACC markers before retrying");
};
const OWNED = new Map([
  [JSON.stringify(["marketplaces", "acc-local"]), ["source_type", "source"]],
  [JSON.stringify(["plugins", "agents-can-communicate@acc-local"]), ["enabled"]],
  [JSON.stringify(["sandbox_workspace_write"]), ["writable_roots"]],
]);

// A bounded lexical scan, not a TOML value parser. Newlines inside strings,
// arrays and inline tables cannot introduce a header or a managed marker.
function* statements(source) {
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
          if (count > 5) unsafe();
        }
        code += source.slice(i, i + count); i += count; quote = null; continue;
      }
      if (quote.length === 1 && /[\r\n]/.test(char)) unsafe();
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
      if (stack.pop() !== (char === "]" ? "[" : "{")) unsafe();
    }
    code += char; i++;
    if (char === "\n" && stack.length === 0) {
      yield { raw: source.slice(start, i), code: code.trim() };
      start = i; code = "";
    }
  }
  if (quote || stack.length) unsafe();
  if (start < source.length) yield { raw: source.slice(start), code: code.trim() };
}

function decodeKey(key) {
  if (key[0] === "'") return key.slice(1, -1);
  if (key[0] !== '"') return key;
  return key.slice(1, -1).replace(/\\(U[\da-fA-F]{8}|u[\da-fA-F]{4}|[btnfr"\\])|\\./g,
    (match, escape) => {
      if (!escape) unsafe();
      if (/^[uU]/.test(escape)) {
        const point = Number.parseInt(escape.slice(1), 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) unsafe();
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
    if (!match) unsafe();
    keys.push(decodeKey(match[0]));
    rest = rest.slice(match[0].length).trimStart();
    if (!rest.startsWith(".")) return { keys, rest };
    rest = rest.slice(1).trimStart();
  }
}

function declaration(code) {
  const header = code.startsWith("[");
  const array = header && code.startsWith("[[");
  const { keys, rest } = keyPath(header ? code.slice(array ? 2 : 1) : code);
  if (header ? rest !== (array ? "]]" : "]") : !rest.startsWith("=")) unsafe();
  return { keys, header, array };
}

/**
 * Ownership is an exact generated table inside real ACC comment markers, with
 * only its generated keys. Other tables (including descendants) and comments
 * are foreign. Unknown keys in an owned table are ambiguous: refuse, never
 * discard them. Codex may insert foreign tables before END; retain their raw
 * bytes in order and append the replacement block after them.
 */
export function inspectConfig(source) {
  const kept = [], declarations = [];
  let inside = false, owned = null, table = [];
  for (const { raw, code } of statements(source)) {
    if (!code && raw.trim() === BEGIN) {
      if (inside) unsafe();
      inside = true; continue;
    }
    if (!code && raw.trim() === END) {
      if (!inside) unsafe();
      inside = false; continue;
    }
    if (!code) {
      if (!inside || !owned || raw.trim()) kept.push(raw);
      continue;
    }
    const entry = declaration(code);
    if (entry.header) {
      table = entry.keys;
      owned = inside ? OWNED.get(JSON.stringify(table)) : null;
      if (owned && entry.array) unsafe();
    } else if (owned) {
      // Markers are comments, so END does not close a TOML table. Removing its
      // header would attach any following foreign assignment to another table.
      if (!inside || entry.keys.length !== 1 || !owned.includes(entry.keys[0])) unsafe();
    }
    if (!owned) {
      kept.push(raw);
      declarations.push(entry.header ? table : [...table, ...entry.keys]);
    }
  }
  if (inside) unsafe();
  const has = prefix => declarations.some(keys => prefix.every((key, i) => keys[i] === key));
  return { source: kept.join(""),
    sandbox: has(["sandbox_workspace_write"]),
    registration: has(["marketplaces", "acc-local"])
      || has(["plugins", "agents-can-communicate@acc-local"]) };
}

export async function readConfig(file) {
  return readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

export async function writeTomlBlock(file, body) {
  const { source } = inspectConfig(await readConfig(file));
  const separator = source === "" || source.endsWith("\n") ? "" : "\n";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${source}${separator}${renderBlock(body)}\n`);
  return file;
}

export async function removeTomlBlock(file) {
  const before = await readConfig(file);
  const { source } = inspectConfig(before);
  if (source === before) return false;
  await writeFile(file, source);
  return true;
}
