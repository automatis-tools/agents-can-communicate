import { createHash } from "node:crypto";
import { assertPortableId } from "@agents-can-communicate/protocol";

export const INDEX_PAGE_BYTES = 65_536;
export const INDEX_PAGE_ENTRIES = 32;
const HASH = /^[a-f0-9]{64}$/;
export class IndexCacheUnavailable extends Error {
  constructor(reason, cause) {
    super(`transaction index unavailable: ${reason}`, { cause });
    this.name = "IndexCacheUnavailable";
    this.reason = reason;
  }
}
const refuse = reason => { throw new IndexCacheUnavailable(reason); };
export function assertPageHash(hash) {
  if (typeof hash !== "string" || !HASH.test(hash)) refuse("invalid_reference");
  return hash;
}
function closed(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) refuse("invalid_page_shape");
}
function unique(values) {
  if (new Set(values).size !== values.length) refuse("duplicate_page_entry");
}
export function canonicalTuple(tuple) {
  if (!Array.isArray(tuple) || ![2, 3].includes(tuple.length)) refuse("invalid_tuple");
  try { tuple.forEach(id => assertPortableId(id, "index tuple member")); }
  catch (error) { throw new IndexCacheUnavailable("invalid_tuple", error); }
  return JSON.stringify(tuple);
}
function limited(values, limit = INDEX_PAGE_ENTRIES) {
  if (!Array.isArray(values) || values.length === 0 || values.length > limit) refuse("page_entry_limit");
}
export function validateIndexPage(page) {
  if (page?.type === "branch") {
    closed(page, ["type", "children"]); limited(page.children, 16);
    const routes = [];
    for (const child of page.children) {
      if (!Array.isArray(child) || child.length !== 2 || !/^[a-f0-9]$/.test(child[0])) refuse("invalid_child");
      assertPageHash(child[1]); routes.push(child[0]);
    }
    unique(routes);
    if (routes.join("") !== [...routes].sort().join("")) refuse("noncanonical_routes");
  } else if (page?.type === "leaf") {
    closed(page, ["type", "entries", "next"]); limited(page.entries);
    if (page.next !== null) assertPageHash(page.next);
    const keys = [];
    for (const entry of page.entries) {
      closed(entry, ["digest", "tuple", "ids"]);
      assertPageHash(entry.digest); assertPageHash(entry.ids); keys.push(canonicalTuple(entry.tuple));
    }
    unique(keys);
    if (keys.some((key, i) => i > 0 && keys[i - 1].localeCompare(key) >= 0)) refuse("noncanonical_keys");
  } else if (page?.type === "group") {
    closed(page, ["type", "ids", "next"]); limited(page.ids);
    if (page.next !== null) assertPageHash(page.next);
    try { page.ids.forEach(id => assertPortableId(id, "index record ID")); }
    catch (error) { throw new IndexCacheUnavailable("invalid_record_id", error); }
    unique(page.ids);
    if (page.ids.some((id, i) => i > 0 && page.ids[i - 1].localeCompare(id) >= 0)) refuse("noncanonical_ids");
  } else refuse("unknown_page_type");
  return page;
}
export function encodeIndexPage(page) {
  validateIndexPage(page);
  // Fixed field order makes insertion order irrelevant to content addressing.
  const canonical = page.type === "branch" ? { type: page.type, children: page.children }
    : page.type === "group" ? { type: page.type, ids: page.ids, next: page.next }
      : { type: page.type, entries: page.entries.map(({ digest, tuple, ids }) => ({ digest, tuple, ids })), next: page.next };
  const bytes = Buffer.from(JSON.stringify(canonical) + "\n");
  if (bytes.length > INDEX_PAGE_BYTES) refuse("page_byte_limit");
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}
export function decodeIndexPage(hash, bytes) {
  assertPageHash(hash);
  if (!Buffer.isBuffer(bytes) || bytes.length > INDEX_PAGE_BYTES) refuse("page_byte_limit");
  let page;
  try { page = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new IndexCacheUnavailable("invalid_page_json", error); }
  const encoded = encodeIndexPage(page);
  if (!encoded.bytes.equals(bytes)) refuse("noncanonical_bytes");
  if (encoded.hash !== hash) refuse("page_hash_mismatch");
  return page;
}
