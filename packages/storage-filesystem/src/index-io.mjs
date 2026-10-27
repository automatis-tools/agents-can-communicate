import path from "node:path";
import { TRANSACTION_INDEXES, assertPortableId } from "@agents-can-communicate/protocol";
import { publishAtomic } from "./atomic-json.mjs";
import { withRegularNoFollow } from "./safe-file.mjs";
import { assertPageHash, decodeIndexPage, encodeIndexPage, INDEX_PAGE_BYTES, IndexCacheUnavailable }
  from "./index-pages.mjs";

// The cache of this index set. ACC 0.12 keeps two indexes in `indexes/v1` and refuses a
// manifest with any other set, so this set lives apart: an older writer never touches it,
// and its commits leave this manifest behind the journal generation, which marks it stale
// (#306). Neither version reads or writes the other's cache.
export const INDEX_DIRECTORY = path.join("indexes", "v2");
export const INDEX_VERSION = 2;
const ROOTS = Object.keys(TRANSACTION_INDEXES).sort().join(",");

function manifestShape(value) {
  const keys = object => object && !Array.isArray(object) ? Object.keys(object).sort().join(",") : "";
  if (keys(value) !== "indexVersion,journalGeneration,roots,workspaceId"
    || value.indexVersion !== INDEX_VERSION || !/^[0-9]{16}$/.test(value.journalGeneration)
    || keys(value.roots) !== ROOTS) {
    throw new IndexCacheUnavailable("invalid_manifest");
  }
  assertPortableId(value.workspaceId, "index workspace ID");
  for (const hash of Object.values(value.roots)) if (hash !== null) assertPageHash(hash);
  return value;
}
export function createIndexIO({ paths, root, publishOptions }) {
  const directory = path.join(root, INDEX_DIRECTORY);
  const options = { ...publishOptions, root, tmpDir: paths.tmp, stageDir: paths.stage, durability: "none" };
  const cache = async operation => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof IndexCacheUnavailable) throw error;
      throw new IndexCacheUnavailable(error.code === "ENOENT" ? "missing_page" : "unsafe_cache_io", error);
    }
  };
  const readBytes = async file => {
    const bytes = await withRegularNoFollow(file, root, "r", (handle, stat) =>
      stat.size > INDEX_PAGE_BYTES ? null : handle.readFile());
    if (bytes === null) throw new IndexCacheUnavailable("page_byte_limit");
    return bytes;
  };
  return Object.freeze({
    readPage: hash => cache(async () => decodeIndexPage(assertPageHash(hash),
      await readBytes(path.join(directory, "pages", hash + ".json")))),
    writePage: page => cache(async () => {
      const { hash, bytes } = encodeIndexPage(page);
      const file = path.join(directory, "pages", hash + ".json");
      let damaged = false;
      try { damaged = !(await readBytes(file)).equals(bytes); }
      catch (error) {
        if (error instanceof IndexCacheUnavailable && error.reason === "page_byte_limit") damaged = true;
        else if (error.code !== "ENOENT") throw error;
      }
      // Valid pages stay immutable. A safely opened but damaged cache file is
      // replaced with the verified bytes for its existing content address.
      await publishAtomic(file, bytes, { ...options, replace: damaged });
      return hash;
    }),
    readManifest: () => cache(async () => {
      let bytes;
      try { bytes = await readBytes(path.join(directory, "cache.json")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      try { return manifestShape(JSON.parse(bytes.toString("utf8"))); }
      catch (error) { throw new IndexCacheUnavailable("invalid_manifest", error); }
    }),
    writeManifest: manifest => cache(async () => {
      manifestShape(manifest);
      await publishAtomic(path.join(directory, "cache.json"),
        Buffer.from(JSON.stringify(manifest) + "\n"), { ...options, replace: true });
    }),
  });
}
