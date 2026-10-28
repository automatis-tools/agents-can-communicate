import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

// Observe public promise readFile(string/file URL/observed handle) and observed
// handle readFile/read/readv, with lexical attribution and exact returned bytes.
// Ordinary stable data options are supported. Exotic/mutating options, Buffer
// paths, foreign handles, callbacks, sync APIs and streams are unobserved.
// Binary-read then decode preserves normal results/errors, not allocation/abort
// race timing. Saved native methods avoid nested counting on Node 24; no locks.
// Captures are sequential (operations within one capture may run concurrently).
// Install at most one probe per test process, and restore it before leaving.
export function createStoreIoProbe(root, { trace = false } = {}) {
  const originals = new Map(), counts = new Map();
  const events = [];
  const files = new Map(), handles = new Map();
  let active = true;
  const filename = input => path.resolve(input instanceof URL ? fileURLToPath(input) : String(input));
  const bucket = input => {
    if (typeof input !== "string" && !(input instanceof URL)) return null;
    let file;
    try { file = input instanceof URL ? fileURLToPath(input) : input; }
    catch { return null; }
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
    if (active && group !== null) counts.set(`${group}/${metric}`, (counts.get(`${group}/${metric}`) ?? 0) + amount);
  };
  const bytes = value => typeof value === "string" ? Buffer.byteLength(value) : value?.byteLength ?? 0;
  const patch = (name, replacement) => {
    originals.set(name, Object.getOwnPropertyDescriptor(fs, name));
    fs[name] = replacement;
  };
  const readFilePlan = options => {
    if (options === undefined || options === null) return { options };
    if (options === "") return { options };
    if (typeof options === "string") return Buffer.isEncoding(options)
      ? { options: { encoding: null }, encoding: options } : null;
    if (typeof options !== "object" || types.isProxy(options)) return null;
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (Reflect.ownKeys(descriptors).some(key => !("value" in descriptors[key]))) return null;
    const encoding = descriptors.encoding?.value;
    if (encoding === undefined || encoding === null || encoding === "") return { options };
    if (typeof encoding !== "string" || !Buffer.isEncoding(encoding)) return null;
    descriptors.encoding = { ...descriptors.encoding, value: null };
    return { options: Object.create(prototype, descriptors), encoding };
  };
  const observeReadFile = async (group, original, receiver, args, optionIndex) => {
    const plan = readFilePlan(args[optionIndex]);
    if (!active || group === null || plan === null) return Reflect.apply(original, receiver, args);
    const input = [...args];
    input[optionIndex] = plan.options;
    const buffer = await Reflect.apply(original, receiver, input);
    const result = plan.encoding === undefined ? buffer : buffer.toString(plan.encoding);
    add(group, "reads"); add(group, "readBytes", buffer.byteLength);
    return result;
  };
  const readFile = fs.readFile;
  patch("readFile", function (...args) {
    return observeReadFile(handles.get(args[0])?.group ?? bucket(args[0]), readFile, this, args, 1);
  });
  const open = fs.open;
  patch("open", async function (...args) {
    const handle = await Reflect.apply(open, this, args), group = bucket(args[0]);
    if (!active) return handle;
    add(group, "opens");
    if (group === null) return handle;
    const info = { bytes: 0, flushes: 0 };
    files.set(filename(args[0]), info);
    const record = { group, info, file: args[0], methods: new Map() };
    handles.set(handle, record);
    for (const method of ["readFile", "read", "readv", "writeFile", "write", "sync", "datasync"]) {
      const original = handle[method];
      record.methods.set(method, Object.getOwnPropertyDescriptor(handle, method));
      handle[method] = async function (...input) {
        const tracked = active ? handles.get(this) : undefined;
        if (tracked === undefined) return Reflect.apply(original, this, input);
        const { group, info, file } = tracked;
        if (method === "readFile") return observeReadFile(group, original, this, input, 0);
        const result = await Reflect.apply(original, this, input);
        if (method === "read" || method === "readv") {
          add(group, "reads"); add(group, "readBytes", result.bytesRead);
        }
        if (method === "writeFile") {
          add(group, "writes"); add(group, "writeBytes", bytes(input[0])); info.bytes += bytes(input[0]);
        }
        if (method === "write") {
          add(group, "writes"); add(group, "writeBytes", result.bytesWritten); info.bytes += result.bytesWritten;
        }
        if (method === "sync" || method === "datasync") {
          add(group, "flushes");
          info.flushes += 1;
          if (active && trace) events.push({ operation: method, file: path.relative(root, String(file)) });
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
      // How much a listing enumerated: one readdir of a long history costs more than one of a short one.
      if (name === "readdir" && Array.isArray(result)) add(bucket(args[0]), "readdirEntries", result.length);
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
      if (active && trace && name === "rename" && bucket(args[0]) !== null) events.push({ operation: name,
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
      if (!active) return;
      active = false;
      try {
        for (const [handle, record] of handles) {
          for (const [method, descriptor] of record.methods) {
            if (descriptor === undefined) delete handle[method];
            else Object.defineProperty(handle, method, descriptor);
          }
        }
      } finally {
        for (const [name, descriptor] of originals) Object.defineProperty(fs, name, descriptor);
        syncBuiltinESMExports();
        handles.clear(); originals.clear();
      }
    },
  };
}

export async function measureTransactionIO(root, operation) {
  const probe = createStoreIoProbe(root);
  try { return await probe.capture(operation); }
  finally { probe.stop(); }
}
