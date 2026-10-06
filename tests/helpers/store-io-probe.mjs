import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Observe real descriptor operations; never replace store methods or durability.
// Install at most one probe per test process, and restore it before leaving.
export function createStoreIoProbe(root, { trace = false } = {}) {
  const originals = new Map(), counts = new Map();
  const events = [];
  const files = new Map();
  const filename = input => path.resolve(input instanceof URL ? fileURLToPath(input) : String(input));
  const bucket = input => {
    if (typeof input !== "string" && !(input instanceof URL)) return null;
    const file = input instanceof URL ? fileURLToPath(input) : input;
    const relative = path.relative(root, path.resolve(file));
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return null;
    const parts = relative.split(path.sep);
    if (parts[0] === "state" && parts.length === 3) return `state:${parts[1]}`;
    if (parts[0] === "indexes") return parts.includes("pages") ? "index-pages" : "index-manifest";
    if (parts[0] === "journal") return "journal";
    if (parts[0] === "retained") return "retention";
    if (["tmp", "stage", "events", "locks"].includes(parts[0])) return parts[0];
    return "metadata";
  };
  const add = (group, metric, amount = 1) => {
    if (group !== null) counts.set(`${group}/${metric}`, (counts.get(`${group}/${metric}`) ?? 0) + amount);
  };
  const bytes = value => typeof value === "string" ? Buffer.byteLength(value) : value?.byteLength ?? 0;
  const patch = (name, replacement) => { originals.set(name, fs[name]); fs[name] = replacement; };
  const open = fs.open;
  patch("open", async (...args) => {
    const handle = await open(...args), group = bucket(args[0]);
    add(group, "opens");
    if (group === null) return handle;
    const info = { bytes: 0, flushes: 0 };
    files.set(filename(args[0]), info);
    for (const method of ["readFile", "writeFile", "write", "sync", "datasync"]) {
      const original = handle[method].bind(handle);
      handle[method] = async (...input) => {
        const result = await original(...input);
        if (method === "readFile") { add(group, "reads"); add(group, "readBytes", bytes(result)); }
        if (method === "writeFile") {
          add(group, "writes"); add(group, "writeBytes", bytes(input[0])); info.bytes += bytes(input[0]);
        }
        if (method === "write") {
          add(group, "writes"); add(group, "writeBytes", result.bytesWritten); info.bytes += result.bytesWritten;
        }
        if (method === "sync" || method === "datasync") {
          add(group, "flushes");
          info.flushes += 1;
          if (trace) events.push({ operation: method, file: path.relative(root, String(args[0])) });
        }
        return result;
      };
    }
    return handle;
  });
  for (const name of ["stat", "lstat", "readdir", "realpath", "rename", "link", "unlink", "mkdir", "rm"]) {
    const original = fs[name];
    patch(name, async (...args) => {
      const result = await original(...args);
      add(bucket(args[0]), name);
      if ((name === "rename" || name === "link") && bucket(args[1]) !== null) {
        const info = files.get(filename(args[0]));
        if (info !== undefined) {
          const target = bucket(args[1]);
          if (!["tmp", "stage", "locks"].includes(target)) {
            add(target, "publications"); add(target, "publicationBytes", info.bytes);
            add(target, "publicationFlushes", info.flushes);
          }
          files.set(filename(args[1]), info);
        }
      }
      if (trace && name === "rename" && bucket(args[0]) !== null) events.push({ operation: name,
        from: path.relative(root, String(args[0])), to: path.relative(root, String(args[1])) });
      return result;
    });
  }
  syncBuiltinESMExports();
  const snapshot = () => {
    const io = Object.fromEntries(counts);
    const stateByKind = {};
    for (const [key, count] of counts) {
      if (key.startsWith("state:") && key.endsWith("/reads")) stateByKind[key.slice(6, -6)] = count;
    }
    const sum = metric => [...counts].filter(([key]) => key.endsWith(`/${metric}`))
      .reduce((total, [, count]) => total + count, 0);
    return { stateReads: Object.values(stateByKind).reduce((sum, value) => sum + value, 0), stateByKind, io,
      pageReads: io["index-pages/reads"] ?? 0, pageWrites: io["index-pages/publications"] ?? 0,
      indexWrittenBytes: (io["index-pages/publicationBytes"] ?? 0) + (io["index-manifest/publicationBytes"] ?? 0),
      indexFlushes: (io["index-pages/flushes"] ?? 0) + (io["index-manifest/flushes"] ?? 0)
        + (io["index-pages/publicationFlushes"] ?? 0) + (io["index-manifest/publicationFlushes"] ?? 0),
      readBytes: sum("readBytes"), writtenBytes: sum("writeBytes"), flushes: sum("flushes"),
      ...(trace ? { trace: [...events] } : {}) };
  };
  return {
    snapshot,
    async capture(operation) {
      counts.clear();
      events.length = 0;
      files.clear();
      const started = performance.now(), result = await operation();
      return { result, elapsedMs: performance.now() - started, ...snapshot() };
    },
    stop() {
      for (const [name, original] of originals) fs[name] = original;
      syncBuiltinESMExports();
    },
  };
}

export async function measureTransactionIO(root, operation) {
  const probe = createStoreIoProbe(root);
  try { return await probe.capture(operation); }
  finally { probe.stop(); }
}
