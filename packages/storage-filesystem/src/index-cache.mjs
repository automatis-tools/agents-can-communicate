import { AccError, EXIT, TRANSACTION_INDEXES, assertIndexTuple, indexKeysFor }
  from "@agents-can-communicate/protocol";
import { assertPublicationDeadline } from "./deadline.mjs";
import { createIndexIO, INDEX_VERSION } from "./index-io.mjs";
import { createIndexTree } from "./index-tree.mjs";
import { encodeIndexPage, IndexCacheUnavailable } from "./index-pages.mjs";
import { LIST_READS } from "./state-reads.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const matches = (kind, record, index, tuple) => indexKeysFor(kind, record)
  .some(key => key.index === index && same(key.tuple, tuple));
const references = page => page.type === "branch" ? page.children.map(([, hash]) => hash)
  : page.type === "leaf" ? [...page.entries.map(entry => entry.ids).filter(ids => typeof ids === "string"), page.next].filter(Boolean)
    : [page.next].filter(Boolean);

export function createIndexCache({ paths, root, workspaceId, publishOptions, loadPrimary }) {
  let diagnostic = [];
  // The last tree rebuilt in memory that could not be published, for the journal
  // generation it describes. A read-only data home in a client sandbox would otherwise
  // read every primary record again for each lookup (#306). Message and receipt records
  // change only through the journal, which moves the generation. A published tree is
  // read from its pages, so it is not kept.
  let unpublished = null;
  // The manifest this instance validated, and the pages it decoded since, for the journal
  // generation the manifest belongs to. Pages are content-addressed and never change, so
  // a walk that makes one lookup per decision reads each page once (#306).
  let validated = null;
  const note = (code, reason) => { diagnostic = [{ code, reason }]; };
  const tools = deadlineAt => {
    const io = createIndexIO({ paths, root, publishOptions: { ...publishOptions, deadlineAt } });
    const bounded = Object.fromEntries(Object.entries(io).map(([name, operation]) => [name, (...args) => {
      assertPublicationDeadline(deadlineAt); return operation(...args);
    }]));
    return { io: bounded, tree: createIndexTree(bounded) };
  };
  async function valid(io, active) {
    const manifest = await io.readManifest();
    if (manifest === null) return null;
    if (active.state !== "idle" || manifest.workspaceId !== workspaceId
      || manifest.journalGeneration !== active.generation) throw new IndexCacheUnavailable("stale_manifest");
    // Descendants are validated on their selected route. A root fault cannot
    // be carried across an unrelated writer by simply changing its epoch.
    for (const hash of Object.values(manifest.roots)) if (hash !== null) await io.readPage(hash);
    return manifest;
  }
  async function phase(name) {
    try { await publishOptions.failAt?.(name); }
    catch (error) { throw new IndexCacheUnavailable("cache_publication_failed", error); }
  }
  async function publishManifest(io, manifest) {
    await phase("after-index-pages");
    await phase("before-index-manifest");
    await io.writeManifest(manifest);
  }
  async function rebuild(active, deadlineAt, { required = false } = {}) {
    // Authoritative reads stay outside every cache-error catch.
    const primaries = await loadPrimary({ deadlineAt });
    const deltas = Object.fromEntries(Object.keys(TRANSACTION_INDEXES).map(index => [index, []]));
    for (const entry of primaries.values()) {
      assertPublicationDeadline(deadlineAt);
      if (entry.record.workspaceId !== workspaceId) {
        throw new AccError(EXIT.DATA, "indexed primary belongs to a different workspace");
      }
      for (const key of indexKeysFor(entry.kind, entry.record)) deltas[key.index].push({ ...key, id: entry.id, operation: "put" });
    }
    const pages = new Map();
    const tree = createIndexTree({ readPage: async hash => pages.get(hash), writePage: async page => {
      assertPublicationDeadline(deadlineAt);
      const { hash } = encodeIndexPage(page); pages.set(hash, page); return hash;
    } });
    const roots = {};
    for (const index of Object.keys(deltas)) roots[index] = await tree.build(deltas[index]);
    // Only pages the roots reach are kept and published.
    const reachable = new Map();
    const keep = hash => {
      if (hash === null || reachable.has(hash)) return;
      reachable.set(hash, pages.get(hash));
      for (const child of references(pages.get(hash))) keep(child);
    };
    for (const hash of Object.values(roots)) keep(hash);
    pages.clear();
    for (const [hash, page] of reachable) pages.set(hash, page);
    const manifest = { indexVersion: INDEX_VERSION, workspaceId, journalGeneration: active.generation, roots };
    const { io } = tools(deadlineAt);
    try {
      // Publish only the final reachable tree, children before parents. The
      // path copies made during a rebuild need never reach the filesystem. Pages of
      // one height go a listing's worth at a time, every one after all of its children:
      // one after another, a cold page read cost twice the listing it replaced (#306).
      const heights = new Map();
      const height = hash => {
        if (!heights.has(hash)) {
          heights.set(hash, 1 + Math.max(-1, ...references(pages.get(hash)).map(height)));
        }
        return heights.get(hash);
      };
      for (const hash of Object.values(roots)) if (hash !== null) height(hash);
      const levels = [];
      for (const [hash, level] of heights) (levels[level] ??= []).push(pages.get(hash));
      for (const level of levels) {
        for (let start = 0; start < level.length; start += LIST_READS) {
          await Promise.all(level.slice(start, start + LIST_READS).map(page => io.writePage(page)));
        }
      }
      await publishManifest(io, manifest);
      note("index_rebuilt", "verified_primary");
      return { manifest, tree, published: true };
    } catch (error) {
      if (!(error instanceof IndexCacheUnavailable)) throw error;
      note("index_unavailable", error.reason);
      if (required) throw error;
    }
    return { manifest, tree, published: false };
  }
  async function lookup(index, tuple, { active, staged, deadlineAt, verify }) {
    assertIndexTuple(index, tuple);
    let tree, manifest;
    try {
      // Each lookup reads through its own deadline; only the decoded pages are shared.
      const { io } = tools(deadlineAt);
      const remembering = pages => ({ ...io, readPage: async hash => {
        if (!pages.has(hash)) pages.set(hash, await io.readPage(hash));
        return pages.get(hash);
      } });
      if (validated === null || validated.generation !== active.generation || active.state !== "idle") {
        validated = null;
        const pages = new Map();
        manifest = await valid(remembering(pages), active);
        if (manifest === null) throw new IndexCacheUnavailable("missing_manifest");
        validated = { generation: active.generation, manifest, pages };
      }
      manifest = validated.manifest;
      tree = createIndexTree(remembering(validated.pages));
      return await select(await tree.lookup(manifest.roots[index], tuple));
    } catch (error) {
      if (!(error instanceof IndexCacheUnavailable)) throw error;
      validated = null;
    }
    if (unpublished === null || unpublished.generation !== active.generation || active.state !== "idle") {
      const result = await rebuild(active, deadlineAt);
      unpublished = result.published ? null : { generation: active.generation, ...result };
      ({ manifest, tree } = result);
    } else ({ manifest, tree } = unpublished);
    return select(await tree.lookup(manifest.roots[index], tuple));

    async function select(ids) {
      const selected = new Set(ids), kind = TRANSACTION_INDEXES[index].kind;
      for (const entry of staged.values()) {
        if (entry.kind !== kind) continue;
        selected.delete(entry.id);
        if (entry.removed !== true && matches(kind, entry.record, index, tuple)) selected.add(entry.id);
      }
      const result = [];
      // Match eager listJsonFiles ordering, including prefix IDs such as a/a-b. Verified a
      // listing's worth at a time: one record after another, a page of a small inbox took
      // twice as long as the listing it replaced (#306).
      const sorted = [...selected].sort((a, b) => `${a}.json`.localeCompare(`${b}.json`));
      for (let start = 0; start < sorted.length; start += LIST_READS) {
        assertPublicationDeadline(deadlineAt);
        const batch = sorted.slice(start, start + LIST_READS);
        const found = await Promise.all(batch.map(id => verify(id)));
        batch.forEach((id, position) => { if (found[position]) result.push(id); });
      }
      return result;
    }
  }
  function prepareDeltas(loaded, staged) {
    const deltas = [];
    for (const [id, next] of staged) {
      const previous = loaded.get(id);
      const oldKeys = previous == null ? [] : indexKeysFor(previous.kind, previous.record);
      const newKeys = next.removed === true ? [] : indexKeysFor(next.kind, next.record);
      for (const key of oldKeys) if (!newKeys.some(found => same(found, key))) deltas.push({ ...key, id: next.id, operation: "remove" });
      for (const key of newKeys) if (!oldKeys.some(found => same(found, key))) deltas.push({ ...key, id: next.id, operation: "put" });
    }
    return deltas;
  }
  async function commit({ before, after, deltas, deadlineAt }) {
    try {
      await phase("after-primary-commit");
      const { io, tree } = tools(deadlineAt), manifest = await valid(io, before);
      if (manifest === null) return; // An unrelated writer never constructs a cache.
      const roots = { ...manifest.roots };
      for (const index of Object.keys(roots)) {
        roots[index] = await tree.apply(roots[index], deltas.filter(delta => delta.index === index));
      }
      await publishManifest(io, { ...manifest, roots, journalGeneration: after.generation });
    } catch (error) {
      if (!(error instanceof IndexCacheUnavailable)
        && !(error.code === EXIT.CONFLICT && Date.now() >= deadlineAt)) throw error;
      note("index_unavailable", error instanceof IndexCacheUnavailable ? error.reason : "deadline_expired");
    }
  }
  return Object.freeze({ lookup, prepareDeltas, commit, rebuild,
    diagnostics: () => diagnostic.map(item => ({ ...item })) });
}
