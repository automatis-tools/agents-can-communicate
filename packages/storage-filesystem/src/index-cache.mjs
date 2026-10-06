import { AccError, EXIT, TRANSACTION_INDEXES, assertIndexTuple, indexKeysFor }
  from "@agents-can-communicate/protocol";
import { assertPublicationDeadline } from "./deadline.mjs";
import { createIndexIO } from "./index-io.mjs";
import { createIndexTree } from "./index-tree.mjs";
import { encodeIndexPage, IndexCacheUnavailable } from "./index-pages.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const matches = (kind, record, index, tuple) => indexKeysFor(kind, record)
  .some(key => key.index === index && same(key.tuple, tuple));
const references = page => page.type === "branch" ? page.children.map(([, hash]) => hash)
  : page.type === "leaf" ? [...page.entries.map(entry => entry.ids), page.next].filter(Boolean)
    : [page.next].filter(Boolean);

export function createIndexCache({ paths, root, workspaceId, publishOptions, loadPrimary }) {
  let diagnostic = [];
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
    for (const index of Object.keys(deltas)) roots[index] = await tree.apply(null, deltas[index]);
    const manifest = { indexVersion: 1, workspaceId, journalGeneration: active.generation, roots };
    const { io } = tools(deadlineAt);
    try {
      // Publish only the final reachable tree, children before parents. The
      // path copies made during a rebuild need never reach the filesystem.
      const published = new Set();
      async function publish(hash) {
        if (hash === null || published.has(hash)) return;
        const page = pages.get(hash);
        for (const child of references(page)) await publish(child);
        await io.writePage(page); published.add(hash);
      }
      for (const hash of Object.values(roots)) await publish(hash);
      await publishManifest(io, manifest);
      note("index_rebuilt", "verified_primary");
    } catch (error) {
      if (!(error instanceof IndexCacheUnavailable)) throw error;
      note("index_unavailable", error.reason);
      if (required) throw error;
    }
    return { manifest, tree };
  }
  async function lookup(index, tuple, { active, staged, deadlineAt, verify }) {
    assertIndexTuple(index, tuple);
    let tree, manifest;
    try {
      const selected = tools(deadlineAt);
      tree = selected.tree;
      manifest = await valid(selected.io, active);
      if (manifest === null) throw new IndexCacheUnavailable("missing_manifest");
      return await select(await tree.lookup(manifest.roots[index], tuple));
    } catch (error) {
      if (!(error instanceof IndexCacheUnavailable)) throw error;
    }
    ({ manifest, tree } = await rebuild(active, deadlineAt));
    return select(await tree.lookup(manifest.roots[index], tuple));

    async function select(ids) {
      const selected = new Set(ids), kind = TRANSACTION_INDEXES[index].kind;
      for (const entry of staged.values()) {
        if (entry.kind !== kind) continue;
        selected.delete(entry.id);
        if (entry.removed !== true && matches(kind, entry.record, index, tuple)) selected.add(entry.id);
      }
      const result = [];
      // Match eager listJsonFiles ordering, including prefix IDs such as a/a-b.
      for (const id of [...selected].sort((a, b) => `${a}.json`.localeCompare(`${b}.json`))) {
        assertPublicationDeadline(deadlineAt);
        if (await verify(id)) result.push(id);
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
