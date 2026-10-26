import { inspectConfig } from "./config-block.mjs";
import { inspectPermissions } from "./permission-ownership.mjs";
import { scanConfig } from "./toml-scan.mjs";

const PROFILE = "acc-workspace";
const literal = value => { try { return JSON.parse(value); } catch { return undefined; } };
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
 * under markers.
 */
export function adoptUnmarked(source, context) {
  // Ambiguous TOML is reported by the ownership checks that follow, with the
  // file it came from; adoption only ever acts on a config it can read.
  try { return adopt(source, context); } catch { return { source, adopted: 0 }; }
}

// An ACC marker ends a table's span, so adoption never takes a marked block apart.
const MARKER = /^# (>>> agents-can-communicate|<<< agents-can-communicate|ACC native permissions )/;

function adopt(source, { marketplaceRoot, stateRoot }) {
  const entries = scanConfig(source);
  const spans = [];
  // A headed table and everything up to the next header or ACC marker.
  const table = keys => {
    const headers = entries.filter(entry => entry.header && same(entry.keys, keys));
    if (headers.length !== 1 || headers[0].array) return null;
    const start = headers[0].start;
    const end = entries.find(entry => entry.start > start
      && (entry.header || (!entry.code && MARKER.test(entry.raw.trim()))))?.start ?? source.length;
    const body = entries.filter(entry => entry.code && !entry.header && entry.start > start && entry.end <= end);
    return { keys, start, end, body };
  };
  // Direct keys of the table only: a dotted key below it is something ACC never writes.
  const direct = (found, entry) => entry.keys.length === found.keys.length + 1;
  const exactly = (found, expected) => found !== null
    && found.body.length === Object.keys(expected).length
    && found.body.every(entry => direct(found, entry)
      && Object.hasOwn(expected, entry.keys.at(-1)) && literal(entry.value) === expected[entry.keys.at(-1)]);

  // Only a registration the managed block does not hold: a marked one is ACC's already.
  if (inspectConfig(source).registration) {
    const marketplace = table(["marketplaces", "acc-local"]);
    if (exactly(marketplace, { source_type: "local", source: marketplaceRoot })) spans.push(marketplace);
    const plugin = table(["plugins", "agents-can-communicate@acc-local"]);
    if (exactly(plugin, { enabled: true })) spans.push(plugin);
  }

  if (inspectPermissions(source).state === "absent") {
    const tables = [["permissions", PROFILE], ["permissions", PROFILE, "filesystem"],
      ["permissions", PROFILE, "network"], ["permissions", PROFILE, "network", "unix_sockets"]].map(table);
    const [root, filesystem, network, sockets] = tables;
    const elsewhere = entries.some(entry => entry.code && entry.keys[0] === "permissions"
      && entry.keys[1] === PROFILE && !tables.some(found => found !== null
        && entry.start >= found.start && entry.end <= found.end));
    const ours = !elsewhere && root !== null && exactly(root, { extends: ":workspace" })
      && (filesystem === null || exactly(filesystem, { [stateRoot]: "write" }))
      && (network === null || exactly(network, { enabled: true }))
      && (sockets === null || sockets.body.every(entry => direct(sockets, entry) && literal(entry.value) === "allow"));
    if (ours) {
      spans.push(...tables.filter(found => found !== null));
      const selected = entries.filter(entry => entry.code && !entry.header && same(entry.keys, ["default_permissions"])
        && literal(entry.value) === PROFILE);
      if (selected.length === 1) spans.push(selected[0]);
    }
  }
  const adopted = spans.toSorted((left, right) => right.start - left.start);
  let result = source;
  for (const span of adopted) result = result.slice(0, span.start) + result.slice(span.end);
  return { source: result, adopted: adopted.length };
}
