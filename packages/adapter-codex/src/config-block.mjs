import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BEGIN, END, renderBlock } from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

const unsafe = (reason = "unrecognized TOML declaration") => {
  throw new AccError(EXIT.CONFLICT, `cannot safely edit Codex config: ${reason}; `
    + "repair ambiguous TOML or ACC markers before retrying", { reason });
};
const ROOT = "# ACC sandbox writable_roots created with: ";
export const sandboxOwnership = root => `${ROOT}${JSON.stringify(root)}`;

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
      yield { raw: source.slice(start, i), code: code.trim() };
      start = i; code = "";
    }
  }
  if (quote || stack.length) unsafe(quote ? "unclosed string" : "unclosed collection");
  if (start < source.length) yield { raw: source.slice(start), code: code.trim() };
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

function declaration(code) {
  const header = code.startsWith("[");
  const array = header && code.startsWith("[[");
  const { keys, rest } = keyPath(header ? code.slice(array ? 2 : 1) : code);
  if (header ? rest !== (array ? "]]" : "]") : !rest.startsWith("=")) unsafe();
  return { keys, header, array, value: header ? null : rest.slice(1).trim() };
}

// An unchanged, newly generated sandbox has value provenance. A legacy or
// edited sandbox belongs to the client as a whole and remains byte-preserved.
function ownsSandbox(body) {
  const metadata = body.filter(item => !item.code && item.raw.trim().startsWith(ROOT));
  const values = body.filter(item => item.code);
  if (metadata.length !== 1 || values.length !== 1) return false;
  const value = values[0].code.match(/^writable_roots\s*=\s*(\[.*\])$/);
  if (!value) return false;
  try {
    const root = JSON.parse(metadata[0].raw.trim().slice(ROOT.length));
    const roots = JSON.parse(value[1]);
    return typeof root === "string" && Array.isArray(roots)
      && roots.length === 1 && roots[0] === root;
  } catch { return false; }
}

function assertRegistration(body, keys) {
  const values = body.filter(item => item.code).map(item => declaration(item.code));
  if (values.some(item => item.keys.length !== 1 || !keys.includes(item.keys[0]))) {
    unsafe("unknown key in owned table");
  }
  const valid = { source_type: /^["']local["']$/, source: /^(?:"(?:[^"\\]|\\.)*"|'[^']*')$/,
    enabled: /^(?:true|false)$/ };
  if (values.length !== keys.length || keys.some(key => values.filter(item =>
    item.keys.length === 1 && item.keys[0] === key && valid[key].test(item.value)).length !== 1)) {
    unsafe("changed or incomplete owned registration");
  }
}

function tableBody(entries, index) {
  const body = [];
  for (const item of entries.slice(index + 1)) {
    if (item.code && declaration(item.code).header) break;
    body.push(item);
  }
  return body;
}

/**
 * Ownership is an exact generated table inside real ACC comment markers, with
 * only its generated keys. Other tables (including descendants) and comments
 * are foreign. Unknown keys in an owned table are ambiguous: refuse, never
 * discard them. Codex may insert foreign tables before END; retain their raw
 * bytes in order and append the replacement block after them.
 */
function inspect(source) {
  const kept = [], declarations = [];
  let inside = false, owned = null, table = [];
  const entries = [...statements(source)];
  for (const [index, { raw, code }] of entries.entries()) {
    if (!code && raw.trim() === BEGIN) {
      if (inside) unsafe("nested BEGIN marker");
      inside = true; continue;
    }
    if (!code && raw.trim() === END) {
      if (!inside) unsafe("unmatched END marker");
      inside = false; continue;
    }
    if (!code) {
      if (!inside || !owned || (raw.trim() && !(table.length === 1
        && table[0] === "sandbox_workspace_write" && raw.trim().startsWith(ROOT)))) kept.push(raw);
      continue;
    }
    const entry = declaration(code);
    if (entry.header) {
      table = entry.keys;
      owned = inside ? OWNED.get(JSON.stringify(table)) : null;
      if (owned && table.length === 1 && table[0] === "sandbox_workspace_write"
        && !ownsSandbox(tableBody(entries, index))) owned = null;
      if (owned && entry.array) unsafe("owned table declared as an array");
      if (owned && table[0] !== "sandbox_workspace_write") {
        assertRegistration(tableBody(entries, index), owned);
      }
    } else if (owned) {
      // Markers are comments, so END does not close a TOML table. Removing its
      // header would attach any following foreign assignment to another table.
      if (!inside) unsafe("assignment continues owned table after END marker");
      if (entry.keys.length !== 1 || !owned.includes(entry.keys[0])) {
        unsafe("unknown key in owned table");
      }
    }
    if (!owned) {
      kept.push(raw);
      declarations.push({ keys: entry.header ? table : [...table, ...entry.keys],
        header: entry.header });
    }
  }
  if (inside) unsafe("missing END marker");
  const has = prefix => declarations.some(({ keys }) => prefix.every((key, i) => keys[i] === key));
  // Assignments occupy their exact namespace: even an empty inline parent is
  // closed to later child tables. Ordinary headers and sibling keys stay valid.
  const assignedParent = declarations.some(({ keys, header }) => !header
    && keys.length === 1 && ["marketplaces", "plugins"].includes(keys[0]));
  return { source: kept.join(""),
    sandbox: has(["sandbox_workspace_write"]),
    registration: assignedParent || has(["marketplaces", "acc-local"])
      || has(["plugins", "agents-can-communicate@acc-local"]) };
}

export function inspectConfig(source, file = "config.toml") {
  try {
    return inspect(source);
  } catch (error) {
    if (!(error instanceof AccError)) throw error;
    // Structural reasons are fixed labels: never include key names or values.
    throw new AccError(error.code, `${file}: ${error.message}`, { ...error.details, file });
  }
}

export async function readConfig(file) {
  return readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

export async function writeTomlBlock(file, body) {
  const { source } = inspectConfig(await readConfig(file), file);
  const separator = source === "" || source.endsWith("\n") ? "" : "\n";
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${source}${separator}${renderBlock(body)}\n`);
  return file;
}

export async function removeTomlBlock(file) {
  const before = await readConfig(file);
  const { source } = inspectConfig(before, file);
  if (source === before) return false;
  await writeFile(file, source);
  return true;
}
