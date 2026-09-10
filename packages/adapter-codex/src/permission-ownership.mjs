import { createHash } from "node:crypto";
import { scanConfig, unsafe } from "./toml-scan.mjs";

const BEGIN = "# ACC native permissions begin ";
const END = "# ACC native permissions end ";
const META = "# ACC native permissions restore ";
const hash = (body, record) => createHash("sha256")
  .update(JSON.stringify({ body, id: record.id, before: record.before, table: record.table })).digest("hex");
const marker = (source, prefix) => source.startsWith(prefix) ? source.slice(prefix.length) : null;

// Permission selection, proxy and network grants form one ownership unit. If
// any component changes, none can be removed independently: enabled networking
// without its proxy has a different security meaning to Codex.
export function inspectPermissions(source) {
  const blocks = [];
  let open = null, metadata = null;
  for (const entry of scanConfig(source)) {
    const comment = entry.code ? "" : entry.raw.trim();
    const start = marker(comment, BEGIN), end = marker(comment, END);
    if (start !== null) {
      if (open || !/^[a-z]+$/.test(start) || blocks.some(block => block.id === start)) {
        unsafe("duplicate or nested native permission marker");
      }
      open = { id: start, start: entry.start, table: entry.table, contentStart: entry.end };
    } else if (comment.startsWith(META)) {
      if (!open || open.id !== "selection" || metadata !== null || entry.start !== open.contentStart) {
        unsafe("misplaced permission metadata");
      }
      try { metadata = JSON.parse(comment.slice(META.length)); }
      catch { unsafe("invalid permission metadata"); }
      open.contentStart = entry.end;
    } else if (end !== null) {
      if (!open || open.id !== end) unsafe("unmatched native permission marker");
      blocks.push({ ...open, end: entry.end, body: source.slice(open.contentStart, entry.start) });
      open = null;
    }
  }
  if (open) return { source, state: "customized" };
  if (!blocks.length && !metadata) return { source, state: "absent" };
  if (!Array.isArray(metadata) || metadata.length !== blocks.length
    || metadata.some(item => !item || typeof item !== "object" || Array.isArray(item))
    || new Set(metadata.map(item => item.id)).size !== metadata.length) return { source, state: "customized" };
  for (const block of blocks) {
    const record = metadata.find(item => item.id === block.id);
    if (!record || Object.keys(record).sort().join() !== "before,hash,id,table"
      || typeof record.before !== "string" || record.hash !== hash(block.body, record)
      || (block.id === "selection" && block.table.length !== 0)
      || JSON.stringify(block.table) !== JSON.stringify(record.table)) {
      return { source, state: "customized" };
    }
  }
  // A retained reference or declaration must not be left pointing at a deleted
  // profile. Ignore peer-looking text inside strings/comments as markers.
  const entries = scanConfig(source);
  const inside = entry => blocks.some(block => entry.start >= block.start && entry.end <= block.end);
  const generatedTables = entries.filter(entry => entry.header && inside(entry)).map(entry => JSON.stringify(entry.keys));
  const outside = entries.filter(entry => !inside(entry));
  // New profile declarations and selectors are custom policy, regardless of
  // how TOML spells their values (including escaped or multiline references).
  if (outside.some(entry => entry.code && (entry.keys.includes("default_permissions")
    || entry.keys[0] === "permissions"
    || (!entry.header && generatedTables.includes(JSON.stringify(entry.table)))))) {
    return { source, state: "customized" };
  }
  let restored = source;
  for (const block of blocks.toSorted((a, b) => b.start - a.start)) {
    restored = restored.slice(0, block.start) + metadata.find(item => item.id === block.id).before
      + restored.slice(block.end);
  }
  // Inserting restored headers can reparent foreign assignments added after
  // a removal marker. Verify the candidate's scopes before restoring any byte.
  let restoredEntries;
  try { restoredEntries = new Map(scanConfig(restored).map(entry => [entry.start, entry])); }
  catch { return { source, state: "customized" }; }
  for (const entry of outside.filter(item => item.code)) {
    const delta = blocks.filter(block => block.end <= entry.start).reduce((total, block) =>
      total + metadata.find(item => item.id === block.id).before.length - (block.end - block.start), 0);
    const candidate = restoredEntries.get(entry.start + delta);
    if (!candidate || JSON.stringify(candidate.keys) !== JSON.stringify(entry.keys)) {
      return { source, state: "customized" };
    }
  }
  return { source: restored, state: "owned" };
}

export function addPermissions(source, edits) {
  const metadata = edits.map(({ id, start, end, body, table = [] }) => {
    const record = { id, before: source.slice(start, end), table };
    return { ...record, hash: hash(body, record) };
  });
  const initialMetadata = JSON.stringify(metadata);
  // Insertions at the same offset retain caller order (selection always first).
  for (const edit of edits.map((item, index) => ({ ...item, index }))
    .sort((a, b) => b.start - a.start || b.index - a.index)) {
    const block = `${BEGIN}${edit.id}\n`
      + (edit.id === "selection" ? `${META}${JSON.stringify(metadata)}\n` : "")
      + edit.body + `${END}${edit.id}\n`;
    source = source.slice(0, edit.start) + block + source.slice(edit.end);
  }
  // Record the installed scope, which can differ after removing a legacy table.
  for (const entry of scanConfig(source)) {
    const id = !entry.code ? marker(entry.raw.trim(), BEGIN) : null;
    const record = metadata.find(item => item.id === id);
    if (!record) continue;
    record.table = entry.table;
    record.hash = hash(edits.find(item => item.id === id).body, record);
  }
  return source.replace(`${META}${initialMetadata}`, `${META}${JSON.stringify(metadata)}`);
}
