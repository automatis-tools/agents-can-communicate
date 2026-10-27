import { createHash } from "node:crypto";
import { assertPortableId } from "@agents-can-communicate/protocol";
import { assertPageHash, canonicalTuple, INLINE_GROUP_IDS, IndexCacheUnavailable } from "./index-pages.mjs";

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
  // A group is the set of record IDs under one tuple. Up to 32 IDs it is one group
  // page; beyond that it branches on the digest of each ID, so a change copies only the
  // route to that ID. Chained pages copied every page in front of the change, which made
  // a group of 4000 cost 184,460 page writes to build (#306). Lookups return IDs in order.
  const idDigest = id => createHash("sha256").update(id).digest("hex");
  async function groupLookup(root) {
    const ids = [], seen = new Set();
    async function collect(hash, depth, prefix) {
      const page = await read(hash, seen);
      if (page.type === "branch") {
        if (depth >= 64) fault("radix_depth_exceeded");
        for (const [route, child] of page.children) await collect(child, depth + 1, prefix + route);
        return;
      }
      if (page.type !== "group" || page.next !== null) fault("invalid_group_reference");
      for (const id of page.ids) {
        if (!idDigest(id).startsWith(prefix)) fault("misrouted_group_id");
        ids.push(id);
      }
    }
    await collect(root, 0, "");
    return ids.sort(compare);
  }
  async function groupPages(ids, depth) {
    if (ids.length <= 32 || depth === 64) return writePage({ type: "group", ids: [...ids].sort(compare), next: null });
    const routes = new Map();
    for (const id of ids) {
      const route = idDigest(id)[depth];
      if (!routes.has(route)) routes.set(route, []);
      routes.get(route).push(id);
    }
    const children = [];
    for (const route of [...routes.keys()].sort()) children.push([route, await groupPages(routes.get(route), depth + 1)]);
    return writePage({ type: "branch", children });
  }
  async function groupUpdate(root, id, operation, depth = 0, seen = new Set()) {
    if (root === null) return operation === "remove" ? null : writePage({ type: "group", ids: [id], next: null });
    const page = await read(root, seen);
    if (page.type === "branch") {
      if (depth >= 64) fault("radix_depth_exceeded");
      const route = idDigest(id)[depth], old = page.children.find(([digit]) => digit === route)?.[1] ?? null;
      const next = await groupUpdate(old, id, operation, depth + 1, seen);
      if (next === old) return root;
      const children = page.children.filter(([digit]) => digit !== route);
      if (next !== null) children.push([route, next]);
      children.sort(([a], [b]) => compare(a, b));
      return children.length === 0 ? null : writePage({ type: "branch", children });
    }
    if (page.type !== "group" || page.next !== null) fault("invalid_group_reference");
    const ids = [...page.ids], at = ids.findIndex(found => compare(found, id) >= 0);
    const position = at === -1 ? ids.length : at;
    if (ids[position] === id) {
      if (operation === "put") return root;
      ids.splice(position, 1);
    } else {
      if (operation === "remove") return root;
      ids.splice(position, 0, id);
    }
    if (ids.length === 0) return null;
    return groupPages(ids, depth);
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
    if (idsRoot === null) return [];
    return Array.isArray(idsRoot) ? [...idsRoot] : groupLookup(idsRoot);
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
  // A small group lives in its leaf entry and moves to a page when it outgrows it; a page
  // stays a page, so a group near the limit does not flip with every change.
  async function groupChange(ids, id, operation) {
    if (!Array.isArray(ids)) return groupUpdate(ids, id, operation);
    const next = ids.filter(found => found !== id);
    if (operation === "put") next.push(id);
    next.sort(compare);
    if (next.length === ids.length && next.every((found, i) => found === ids[i])) return ids;
    if (next.length === 0) return null;
    return next.length <= INLINE_GROUP_IDS ? next : groupPages(next, 0);
  }
  async function update(root, tuple, id, operation, depth = 0, prefix = "", seen = new Set()) {
    const hash = assertPageHash(digestTuple(tuple)), key = canonicalTuple(tuple);
    if (root === null) {
      if (operation === "remove") return null;
      return leaf([{ digest: hash, tuple, ids: [id] }]);
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
      const ids = await groupChange(entries[at].ids, id, operation);
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
    entries.push({ digest: hash, tuple, ids: [id] });
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
