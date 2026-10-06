import path from "node:path";
import { assertPortableId } from "@agents-can-communicate/protocol";
import { publishAtomic } from "./atomic-json.mjs";
import { withRegularNoFollow } from "./safe-file.mjs";
import { assertPageHash, decodeIndexPage, encodeIndexPage, INDEX_PAGE_BYTES, IndexCacheUnavailable }
  from "./index-pages.mjs";

function manifestShape(value) {
  const keys = object => object && !Array.isArray(object) ? Object.keys(object).sort().join(",") : "";
  if (keys(value) !== "indexVersion,journalGeneration,roots,workspaceId"
    || value.indexVersion !== 1 || !/^[0-9]{16}$/.test(value.journalGeneration)
    || keys(value.roots) !== "messageByClientKey,receiptsByMessage") {
    throw new IndexCacheUnavailable("invalid_manifest");
  }
  assertPortableId(value.workspaceId, "index workspace ID");
  for (const hash of Object.values(value.roots)) if (hash !== null) assertPageHash(hash);
  return value;
}
export function createIndexIO({ paths, root, publishOptions }) {
  const directory = path.join(root, "indexes", "v1");
  const options = { ...publishOptions, root, tmpDir: paths.tmp, stageDir: paths.stage, durability: "none" };
  const cache = async operation => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof IndexCacheUnavailable) throw error;
      throw new IndexCacheUnavailable(error.code === "ENOENT" ? "missing_page" : "unsafe_cache_io", error);
    }
  };
  const readBytes = file => withRegularNoFollow(file, root, "r", async (handle, stat) => {
    if (stat.size > INDEX_PAGE_BYTES) throw new IndexCacheUnavailable("page_byte_limit");
    return handle.readFile();
  });
  return Object.freeze({
    readPage: hash => cache(async () => decodeIndexPage(assertPageHash(hash),
      await readBytes(path.join(directory, "pages", hash + ".json")))),
    writePage: page => cache(async () => {
      const { hash, bytes } = encodeIndexPage(page);
      await publishAtomic(path.join(directory, "pages", hash + ".json"), bytes, { ...options, replace: false });
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
