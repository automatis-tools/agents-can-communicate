import { inspectConfig } from "./config-block.mjs";
import { inspectPermissions } from "./permission-ownership.mjs";
import { scanConfig } from "./toml-scan.mjs";

const PROFILE = "acc-workspace";
// A TOML basic or literal string, or a boolean: the only values ACC writes.
const literal = value => {
  if (/^'[^'\r\n]*'$/.test(value)) return value.slice(1, -1);
  try { return JSON.parse(value); } catch { return undefined; }
};
const same = (keys, expected) => JSON.stringify(keys) === JSON.stringify(expected);

/**
 * ACC's own Codex entries, recognised by their content when a rewrite of
 * config.toml dropped the comment markers ACC owns them by (#329).
 *
 * On the maintainer's machine another program sorted the file and removed
 * every comment. ACC then took its own marketplace and plugin entries for
 * someone else's, refused the Codex refresh, and the update stayed pending
 * for every client. An entry is ACC's only when it holds exactly what ACC
 * writes - the marketplace at ACC's own root, the plugin with nothing but
 * `enabled = true`, the profile with nothing but ACC's grants - as headed
 * tables; anything else stays the user's and is refused or preserved as
 * before. The adopted entries are removed, and install writes them again
 * under markers. A comment among them was written after the rewrite, so it is
 * the user's and stays.
 *
 * What ACC moved aside when it installed - the user's own selection, a
 * `network_proxy` they had set - lived in the restore metadata the rewrite
 * removed, and cannot come back. An adopted selection is removed with the
 * profile, so uninstall leaves the narrower default, never a wider one.
 */
export function adoptUnmarked(source, context) {
  // Ambiguous TOML is reported by the ownership checks that follow, with the
  // file it came from; adoption only ever acts on a config it can read.
  try { return adopt(source, context); } catch { return { source, adopted: 0 }; }
}

// An ACC marker ends a table's span, so adoption never takes a marked block apart.
const MARKER = /^# (>>> agents-can-communicate|<<< agents-can-communicate|ACC native permissions )/;

function adopt(source, { marketplaceRoot, stateRoot, sockets = [] }) {
  const entries = scanConfig(source);
  const spans = [];
  // A headed table and everything up to the next header or ACC marker. Its
  // spans are the header, its keys and the blank lines between them.
  const table = keys => {
    const headers = entries.filter(entry => entry.header && same(entry.keys, keys));
    if (headers.length !== 1 || headers[0].array) return null;
    const header = headers[0];
    const end = entries.find(entry => entry.start > header.start
      && (entry.header || (!entry.code && MARKER.test(entry.raw.trim()))))?.start ?? source.length;
    const inside = entries.filter(entry => entry.start > header.start && entry.end <= end);
    const body = inside.filter(entry => entry.code);
    const last = body.at(-1)?.end ?? header.end;
    return { keys, header, end, body,
      spans: [header, ...inside.filter(entry => entry.end <= last && (entry.code || entry.raw.trim() === ""))] };
  };
  // Direct keys of the table only: a dotted key below it is something ACC never writes.
  const direct = (found, entry) => entry.keys.length === found.keys.length + 1;
  const exactly = (found, expected) => {
    if (found === null) return false;
    const names = found.body.map(entry => entry.keys.at(-1));
    return new Set(names).size === names.length && same(names.toSorted(), Object.keys(expected).toSorted())
      && found.body.every(entry => direct(found, entry) && literal(entry.value) === expected[entry.keys.at(-1)]);
  };
  // Every declaration under the prefix lies in one of the tables found.
  const within = (prefix, tables) => entries.every(entry => !entry.code
    || !prefix.every((key, index) => entry.keys[index] === key)
    || tables.some(found => found !== null && entry.start >= found.header.start && entry.end <= found.end));

  // Only a registration the managed block does not hold: a marked one is ACC's
  // already. The marketplace and the plugin are adopted together or not at all.
  if (inspectConfig(source).registration) {
    const marketplace = table(["marketplaces", "acc-local"]);
    const plugin = table(["plugins", "agents-can-communicate@acc-local"]);
    if (exactly(marketplace, { source_type: "local", source: marketplaceRoot })
      && exactly(plugin, { enabled: true })
      && within(["marketplaces", "acc-local"], [marketplace])
      && within(["plugins", "agents-can-communicate@acc-local"], [plugin])) {
      spans.push(...marketplace.spans, ...plugin.spans);
    }
  }

  if (inspectPermissions(source).state === "absent") {
    const tables = [["permissions", PROFILE], ["permissions", PROFILE, "filesystem"],
      ["permissions", PROFILE, "network"], ["permissions", PROFILE, "network", "unix_sockets"]].map(table);
    const [root, filesystem, network, socketTable] = tables;
    const granted = new Set(sockets);
    const selections = entries.filter(entry => entry.code && !entry.header && same(entry.keys, ["default_permissions"]));
    const selection = selections.length === 1 && [PROFILE, ":workspace"].includes(literal(selections[0].value))
      ? selections[0] : null;
    // Another setting that names the profile would be left naming none.
    const named = entries.some(entry => entry.code && !entry.header && entry !== selection
      && literal(entry.value) === PROFILE);
    // Every ACC that wrote the profile wrote all four tables, with at least
    // Codex's own socket; a profile of that name without them is the user's.
    const ours = !named && within(["permissions", PROFILE], tables) && exactly(root, { extends: ":workspace" })
      && exactly(filesystem, { [stateRoot]: "write" }) && exactly(network, { enabled: true })
      && socketTable !== null && socketTable.body.length > 0 && socketTable.body.every(entry =>
        direct(socketTable, entry) && granted.has(entry.keys.at(-1)) && literal(entry.value) === "allow");
    if (ours) {
      spans.push(...tables.filter(found => found !== null).flatMap(found => found.spans));
      if (selection) spans.push(selection);
      // A rewrite can write the parent table out; left empty, it would read as
      // a permissions policy of the user's own.
      const parent = table(["permissions"]);
      if (parent !== null && parent.body.length === 0 && within(["permissions"], [parent, ...tables])) {
        spans.push(...parent.spans);
      }
    }
  }
  const adopted = [...new Map(spans.map(span => [span.start, span])).values()]
    .toSorted((left, right) => right.start - left.start);
  let result = source;
  for (const span of adopted) result = result.slice(0, span.start) + result.slice(span.end);
  return { source: result, adopted: adopted.length };
}
