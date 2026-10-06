import { createHash } from "node:crypto";
import { assertPortableId } from "@agents-can-communicate/protocol";
import { assertPageHash, canonicalTuple, IndexCacheUnavailable } from "./index-pages.mjs";

const compare = (a, b) => a.localeCompare(b);
const keyOf = entry => canonicalTuple(entry.tuple);
const digest = tuple => createHash("sha256").update(canonicalTuple(tuple)).digest("hex");
const fault = reason => { throw new IndexCacheUnavailable(reason); };
export function createIndexTree({ readPage, writePage, digestTuple = digest }) {
  async function read(hash, seen) {
    assertPageHash(hash);
    if (seen.has(hash)) fault("page_cycle");
    seen.add(hash);
    return readPage(hash);
  }
  async function groupLookup(root) {
    const ids = [], seen = new Set();
    while (root !== null) {
      const page = await read(root, seen);
      if (page.type !== "group") fault("invalid_group_reference");
      for (const id of page.ids) {
        if (ids.length && compare(ids.at(-1), id) >= 0) fault("duplicate_or_unordered_group");
        ids.push(id);
      }
      root = page.next;
    }
    return ids;
  }
  async function groupUpdate(root, id, operation, seen = new Set()) {
    if (root === null) return operation === "remove" ? null : writePage({ type: "group", ids: [id], next: null });
    const page = await read(root, seen);
    if (page.type !== "group") fault("invalid_group_reference");
    const position = page.ids.findIndex(found => compare(found, id) >= 0);
    if (position === -1 && page.next !== null) {
      const next = await groupUpdate(page.next, id, operation, seen);
      return next === page.next ? root : writePage({ ...page, next });
    }
    const ids = [...page.ids], at = position === -1 ? ids.length : position;
    if (ids[at] === id) {
      if (operation === "put") return root;
      ids.splice(at, 1);
    } else {
      if (operation === "remove") return root;
      ids.splice(at, 0, id);
    }
    if (ids.length === 0) return page.next;
    if (ids.length <= 32) return writePage({ ...page, ids });
    const next = await writePage({ type: "group", ids: ids.slice(16), next: page.next });
    return writePage({ type: "group", ids: ids.slice(0, 16), next });
  }
  function checkNode(page, depth, prefix) {
    if (page.type === "branch") {
      if (depth >= 64) fault("radix_depth_exceeded");
    } else if (page.type === "leaf") {
      if (page.next !== null && depth !== 64) fault("unexpected_collision_page");
      for (const entry of page.entries) {
        if (!entry.digest.startsWith(prefix) || entry.digest !== digestTuple(entry.tuple)) fault("misrouted_tuple");
      }
    } else fault("invalid_tree_reference");
  }
  async function lookup(root, tuple) {
    const key = canonicalTuple(tuple), hash = assertPageHash(digestTuple(tuple)), seen = new Set();
    let depth = 0, prefix = "", idsRoot = null;
    while (root !== null) {
      const page = await read(root, seen); checkNode(page, depth, prefix);
      if (page.type === "branch") {
        const route = hash[depth++]; prefix += route;
        root = page.children.find(([digit]) => digit === route)?.[1] ?? null;
      } else {
        const found = page.entries.find(entry => keyOf(entry) === key);
        if (found) {
          if (idsRoot !== null) fault("duplicate_collision_key");
          idsRoot = found.ids;
        }
        root = page.next;
      }
    }
    return idsRoot === null ? [] : groupLookup(idsRoot);
  }
  const leaf = (entries, next = null) => writePage({ type: "leaf",
    entries: [...entries].sort((a, b) => compare(keyOf(a), keyOf(b))), next });
  async function split(entries, depth) {
    if (entries.length <= 32) return leaf(entries);
    if (depth === 64) {
      let next = null;
      for (let end = entries.length; end > 0; end -= 32) {
        next = await leaf(entries.slice(Math.max(0, end - 32), end), next);
      }
      return next;
    }
    const routes = new Map();
    for (const entry of entries) {
      const route = entry.digest[depth];
      if (!routes.has(route)) routes.set(route, []);
      routes.get(route).push(entry);
    }
    const children = [];
    for (const route of [...routes.keys()].sort()) children.push([route, await split(routes.get(route), depth + 1)]);
    return writePage({ type: "branch", children });
  }
  async function update(root, tuple, id, operation, depth = 0, prefix = "", seen = new Set()) {
    const hash = assertPageHash(digestTuple(tuple)), key = canonicalTuple(tuple);
    if (root === null) {
      if (operation === "remove") return null;
      return leaf([{ digest: hash, tuple, ids: await groupUpdate(null, id, operation) }]);
    }
    const page = await read(root, seen); checkNode(page, depth, prefix);
    if (page.type === "branch") {
      const route = hash[depth], old = page.children.find(([digit]) => digit === route)?.[1] ?? null;
      const next = await update(old, tuple, id, operation, depth + 1, prefix + route, seen);
      if (old === next) return root;
      const children = page.children.filter(([digit]) => digit !== route);
      if (next !== null) children.push([route, next]);
      children.sort(([a], [b]) => compare(a, b));
      return children.length === 0 ? null : writePage({ type: "branch", children });
    }
    const entries = [...page.entries], at = entries.findIndex(entry => keyOf(entry) === key);
    if (at !== -1) {
      const ids = await groupUpdate(entries[at].ids, id, operation);
      if (ids === entries[at].ids) return root;
      if (ids === null) entries.splice(at, 1);
      else entries[at] = { ...entries[at], ids };
      return entries.length === 0 ? page.next : leaf(entries, page.next);
    }
    if (page.next !== null) {
      const next = await update(page.next, tuple, id, operation, depth, prefix, seen);
      return next === page.next ? root : leaf(entries, next);
    }
    if (operation === "remove") return root;
    entries.push({ digest: hash, tuple, ids: await groupUpdate(null, id, operation) });
    return split(entries, depth);
  }
  async function apply(root, deltas) {
    for (const { tuple, id, operation } of deltas) {
      assertPortableId(id, "index record ID");
      if (!["put", "remove"].includes(operation)) fault("invalid_delta");
      root = await update(root, tuple, id, operation);
    }
    return root;
  }
  return Object.freeze({ lookup, apply });
}
