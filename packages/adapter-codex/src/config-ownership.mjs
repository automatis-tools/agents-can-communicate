import { BEGIN, END } from "@agents-can-communicate/adapter-sdk";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

const ROOT = "# ACC sandbox writable_roots created with: ";
export const sandboxOwnership = root => `${ROOT}${JSON.stringify(root)}`;
const ambiguous = () => new AccError(EXIT.CONFLICT,
  "ambiguous Codex TOML ownership; config was preserved; review its ACC registration before retrying");

// TOML basic keys permit both four- and eight-digit Unicode escapes. JSON's
// decoder rejects the latter and accepts surrogate escapes TOML forbids.
function basicKey(value) {
  const escapes = { '"': '"', "\\": "\\", b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" };
  return value.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|U[\da-fA-F]{8}|.)/g, (_, escape) => {
    if (Object.hasOwn(escapes, escape)) return escapes[escape];
    if (!/^(?:u[\da-fA-F]{4}|U[\da-fA-F]{8})$/.test(escape)) throw ambiguous();
    const point = Number.parseInt(escape.slice(1), 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw ambiguous();
    return String.fromCodePoint(point);
  });
}

// A boundary scanner, not a TOML round-tripper. Values remain opaque. Tracking
// quoted strings and value containers prevents strings/arrays from inventing
// table headers or ownership comments. Unknown syntax is never deletion authority.
function tablePath(line) {
  const match = line.trimEnd().match(/^\s*(\[\[?)(.*?)\]\]?\s*(?:#.*)?$/);
  if (!match) throw ambiguous();
  const parts = [];
  let rest = match[2].trim();
  while (rest) {
    const key = rest.match(/^(?:([A-Za-z0-9_-]+)|("(?:[^"\\]|\\.)*")|'([^']*)')\s*/);
    if (!key) throw ambiguous();
    parts.push(key[1] ?? (key[2] ? basicKey(key[2]) : key[3]));
    rest = rest.slice(key[0].length);
    if (!rest) break;
    if (!rest.startsWith(".")) throw ambiguous();
    rest = rest.slice(1).trimStart();
    if (!rest) throw ambiguous();
  }
  if (!parts.length) throw ambiguous();
  return { parts, array: match[1] === "[[" };
}

function sections(source) {
  const result = [{ lines: [], managed: false, parts: [], assignments: [] }];
  let inside = false;
  let quote = null;
  const containers = [];
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const neutral = quote === null && containers.length === 0;
    if (neutral && line.trim() === BEGIN) { inside = true; continue; }
    if (neutral && line.trim() === END) { inside = false; continue; }
    if (neutral && /^\s*\[/.test(line)) {
      result.push({ lines: [line], managed: inside, assignments: [], ...tablePath(line) });
      continue;
    }
    if (neutral) {
      const key = line.match(/^\s*((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=/);
      if (key) result.at(-1).assignments.push([
        ...result.at(-1).parts, ...tablePath(`[${key[1]}]`).parts,
      ]);
    }
    result.at(-1).lines.push(line);
    for (let i = 0; i < line.length; i++) {
      if (quote) {
        if (quote.startsWith('"') && line[i] === "\\") { i++; continue; }
        if (line.startsWith(quote, i)) {
          let closing = quote.length;
          if (quote.length === 3) {
            // A fourth/fifth quote is content at the end of a multiline value,
            // not the beginning of a new string after its closing delimiter.
            while (line[i + closing] === quote[0]) closing++;
            if (closing > 5) throw ambiguous();
          }
          i += closing - 1;
          quote = null;
        }
        continue;
      }
      if (line[i] === "#") break;
      if (line[i] === '"' || line[i] === "'") {
        quote = line.startsWith(line[i].repeat(3), i) ? line[i].repeat(3) : line[i];
        i += quote.length - 1;
      } else if ("[{".includes(line[i])) containers.push(line[i]);
      else if ("]}".includes(line[i])) {
        if (containers.pop() !== (line[i] === "]" ? "[" : "{")) throw ambiguous();
      }
    }
    if (quote?.length === 1) throw ambiguous();
  }
  if (quote || containers.length) throw ambiguous();
  return result;
}

const significant = lines => lines.map(line => line.trim())
  .filter(line => line !== "" && !line.startsWith("#"));

function owned(section) {
  if (!section.managed) return false;
  const name = section.parts.join("\0");
  const body = significant(section.lines.slice(1));
  if (name === "marketplaces\0acc-local" || name === "plugins\0agents-can-communicate@acc-local") {
    // Unknown fields in ACC's registration cannot be dropped or duplicated.
    // Refuse instead of changing their meaning by deleting their table header.
    const patterns = name.startsWith("marketplaces")
      ? [/^source_type\s*=\s*["']local["']\s*(?:#.*)?$/,
        /^source\s*=\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/]
      : [/^enabled\s*=\s*(?:true|false)\s*(?:#.*)?$/];
    if (section.array || body.length !== patterns.length
      || patterns.some(pattern => body.filter(line => pattern.test(line)).length !== 1)) throw ambiguous();
    return true;
  }
  if (name !== "sandbox_workspace_write" || section.array) return false;
  const metadata = section.lines.map(line => line.trim()).filter(line => line.startsWith(ROOT));
  // Legacy blocks have no value provenance. A changed or extended sandbox is
  // the client's whole table, including roots ACC once contributed. Preserve it.
  if (metadata.length !== 1 || body.length !== 1) return false;
  const value = body[0].match(/^writable_roots\s*=\s*(\[.*\])\s*(?:#.*)?$/);
  if (!value) return false;
  try {
    const root = JSON.parse(metadata[0].slice(ROOT.length));
    const roots = JSON.parse(value[1]);
    return typeof root === "string" && Array.isArray(roots)
      && roots.length === 1 && roots[0] === root;
  } catch { return false; }
}

export function stripCodexBlock(source) {
  return sections(source).filter(section => !owned(section))
    .flatMap(section => section.lines).join("");
}

export function declaresCodexTable(source, ...prefix) {
  const parsed = sections(source);
  return parsed.some(section => prefix.every((key, i) => section.parts[i] === key))
    // Dotted/inline assignments may define the table or one of its ancestors.
    || parsed.some(section => section.assignments.some(keys =>
      keys.slice(0, prefix.length).every((key, i) => key === prefix[i])));
}
