import assert from "node:assert/strict";
import fs, * as namedFs from "node:fs/promises";
import { readFile as namedReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createStoreIoProbe, measureTransactionIO } from "./helpers/store-io-probe.mjs";

const nativeReadFile = fs.readFile, nativeOpen = fs.open;
const methods = ["readFile", "read", "readv", "writeFile", "write", "sync", "datasync"];
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "acc-io-controls-"));
  const probes = [], handles = [];
  t.after(async () => {
    for (const probe of probes) probe.stop();
    for (const handle of handles) await handle.close();
    await fs.rm(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, "store"), message = path.join(root, "state/message/one.json");
  const receipt = path.join(root, "state/receipt/one.json"), page = path.join(root, "indexes/v2/pages/one.json");
  const metadata = path.join(root, "meta"), outside = path.join(parent, "store-sibling/meta");
  for (const file of [message, receipt, page, metadata, outside]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from([65, 0xc3, 0xa9, 0xff, 66]));
  }
  return { root, message, receipt, page, metadata, outside,
    observe() { const probe = createStoreIoProbe(root); probes.push(probe); return probe; },
    retain(handle) { handles.push(handle); return handle; } };

}

test("direct named/default/path/URL reads count real bytes and exclude siblings", async t => {
  const f = await fixture(t), probe = f.observe();
  t.after(() => probe.stop());
  for (const [read, file, group] of [[namedReadFile, f.message, "state:message"],
    [fs.readFile, pathToFileURL(f.receipt), "state:receipt"],
    [fs.readFile, f.page, "index-pages"], [fs.readFile, f.metadata, "metadata"]]) {
    const actual = await probe.capture(() => read(file));
    assert.deepEqual(actual.result, Buffer.from([65, 0xc3, 0xa9, 0xff, 66]));
    assert.equal(actual.io[`${group}/reads`], 1);
    assert.equal(actual.readBytes, 5);
    assert.equal(actual.io[`${group}/opens`] ?? 0, 0);
    assert.equal(actual.stateReads, group.startsWith("state:") ? 1 : 0);
    assert.equal(actual.pageReads, group === "index-pages" ? 1 : 0);
  }
  assert.equal((await probe.capture(() => fs.readFile(f.outside))).readBytes, 0);
});

async function opened(file, operation) {
  const handle = await fs.open(file, "r");
  try { return await operation(handle); }
  finally { await handle.close(); }
}
function reads(actual, count, bytes) {
  assert.equal(actual.stateReads, count);
  assert.deepEqual(actual.stateByKind, { message: count });
  assert.equal(actual.readBytes, bytes);
}

test("handle readFile and direct forwarding preserve position and count exactly once", async t => {
  const f = await fixture(t), probe = f.observe();
  t.after(() => probe.stop());
  for (const direct of [false, true]) await opened(f.message, async handle => {
    await handle.read(Buffer.alloc(2), 0, 2, null);
    const actual = await probe.capture(() => direct ? fs.readFile(handle) : handle.readFile());
    assert.deepEqual(actual.result, Buffer.from([0xa9, 0xff, 66]));
    reads(actual, 1, 3);
    const eof = await probe.capture(() => direct ? fs.readFile(handle) : handle.readFile());
    assert.deepEqual(eof.result, Buffer.alloc(0)); reads(eof, 1, 0);
  });
  await opened(f.message, first => opened(f.receipt, async receiver => {
    const borrowed = await probe.capture(() => first.readFile.call(receiver));
    assert.deepEqual(borrowed.result, Buffer.from([65, 0xc3, 0xa9, 0xff, 66]));
    assert.deepEqual(borrowed.stateByKind, { receipt: 1 }); assert.equal(borrowed.readBytes, 5);
  }));
});

test("read/readv retain buffers, offsets, partial and EOF results under concurrent reads", async t => {
  const f = await fixture(t), probe = f.observe();
  t.after(() => probe.stop());
  await opened(f.message, async handle => {
    const buffer = Buffer.alloc(7, 90);
    const partial = await probe.capture(() => handle.read(buffer, 2, 4, 3));
    assert.equal(partial.result.buffer, buffer);
    assert.equal(partial.result.bytesRead, 2);
    assert.deepEqual(buffer, Buffer.from([90, 90, 0xff, 66, 90, 90, 90])); reads(partial, 1, 2);
    const eof = await probe.capture(() => handle.read({ buffer, offset: 1, length: 2, position: 5 }));
    assert.equal(eof.result.buffer, buffer); assert.equal(eof.result.bytesRead, 0); reads(eof, 1, 0);
    const zero = await probe.capture(() => handle.read(buffer, 0, 0, 0)); reads(zero, 1, 0);
    const buffers = [Buffer.alloc(2), Buffer.alloc(4, 90)];
    const vector = await probe.capture(() => handle.readv(buffers, 1));
    assert.equal(vector.result.buffers, buffers); assert.equal(vector.result.bytesRead, 4);
    assert.deepEqual(buffers, [Buffer.from([0xc3, 0xa9]), Buffer.from([0xff, 66, 90, 90])]);
    reads(vector, 1, 4);
    const vectorEof = await probe.capture(() => handle.readv(buffers, 5));
    assert.equal(vectorEof.result.buffers, buffers); reads(vectorEof, 1, 0);
    const concurrent = await probe.capture(() => Promise.all([fs.readFile(f.message),
      namedReadFile(f.message), handle.read(Buffer.alloc(2), 0, 2, 0),
      handle.readv([Buffer.alloc(1), Buffer.alloc(2)], 2)]));
    reads(concurrent, 4, 15);
    assert.deepEqual(concurrent.result[0], Buffer.from([65, 0xc3, 0xa9, 0xff, 66]));
    assert.equal(concurrent.result[2].bytesRead, 2); assert.equal(concurrent.result[3].bytesRead, 3);
  });
});

test("encoding returns match native decoding while byte totals use the original Buffer", async t => {
  const f = await fixture(t);
  const cases = [Buffer.from([65, 0xc3, 0xa9, 0xff, 66]), Buffer.from([0xe2, 0x82]),
    Buffer.from([65, 0, 66]), Buffer.from("é🐈".repeat(90_000))];
  for (const input of cases) {
    await fs.writeFile(f.message, input);
    const controller = new AbortController();
    for (const encoding of [undefined, null, "utf8", "utf16le", "latin1", "hex", "base64"]) {
      const options = Object.freeze({ encoding, flag: "r", signal: controller.signal });
      const expected = await nativeReadFile(f.message, options);
      const probe = f.observe();
      try {
        for (const option of [options, ...(encoding ? [encoding] : [])]) {
          for (const mode of ["path", "handle", "forwarded"]) {
            const actual = await probe.capture(() => mode === "path" ? fs.readFile(f.message, option)
              : opened(f.message, handle => mode === "handle"
                ? handle.readFile(option) : fs.readFile(handle, option)));
            assert.deepEqual(actual.result, expected, `${encoding}/${mode}/${input.length}`);
            assert.equal(typeof actual.result, typeof expected); reads(actual, 1, input.length);
          }
        }
        assert.equal(options.encoding, encoding);
      } finally { probe.stop(); }
    }
  }
});

const errorFacts = error => Object.fromEntries(["name", "code", "message", "syscall", "path", "cause"]
  .filter(key => error[key] !== undefined).map(key => [key, error[key]]));
async function rejection(operation) {
  try { await operation(); assert.fail("expected native rejection"); }
  catch (error) { return error; }
}

test("native errors, validation ordering and aborted signals add no successful reads", async t => {
  const f = await fixture(t), controller = new AbortController();
  controller.abort(new Error("unique abort reason"));
  const invalidUrl = new URL("https://example.test/file");
  const cases = [[f.message + ".missing"], [f.message, "invalid-encoding"], [f.message, 42],
    [f.message, { encoding: false }], [f.message, { flag: "invalid-flag" }],
    [f.message, { signal: controller.signal, encoding: "utf8" }],
    [f.message, Object.defineProperty({ encoding: "utf8" }, "signal", { value: controller.signal })],
    [invalidUrl, "invalid-encoding"]];
  const expected = await Promise.all(cases.map(args => rejection(() => nativeReadFile(...args))));
  const probe = f.observe(); t.after(() => probe.stop());
  for (let i = 0; i < cases.length; i++) {
    const actual = await probe.capture(() => rejection(() => fs.readFile(...cases[i])));
    assert.deepEqual(errorFacts(actual.result), errorFacts(expected[i]));
    assert.equal(actual.stateReads, 0); assert.equal(actual.readBytes, 0);
  }
  const openedFailure = await probe.capture(async () => {
    const handle = await fs.open(f.message, "r"); await handle.close();
    return rejection(() => handle.readFile());
  });
  assert.equal(openedFailure.result.code, "EBADF"); assert.equal(openedFailure.stateReads, 0);
  assert.equal(openedFailure.io["state:message/opens"], 1);
  await opened(f.message, async handle => {
    const badRead = await probe.capture(() => rejection(() => handle.read(Buffer.alloc(1), 2, 1, 0)));
    assert.equal(badRead.result.code, "ERR_OUT_OF_RANGE"); assert.equal(badRead.stateReads, 0);
    const badVector = await probe.capture(() => rejection(() => handle.readv([null], 0)));
    assert.equal(badVector.result.code, "ERR_INVALID_ARG_TYPE"); assert.equal(badVector.stateReads, 0);
  });
  const missingOpen = await probe.capture(() => rejection(() => fs.open(f.message + ".missing")));
  assert.deepEqual(missingOpen.io, {});
});

test("unsupported options/paths/foreign handles pass through unchanged without guessed counts", async t => {
  const f = await fixture(t), foreign = f.retain(await nativeOpen(f.message, "r"));
  const sentinel = new Error("getter sentinel");
  const getter = { get encoding() { throw sentinel; } };
  const proxy = new Proxy({ encoding: "utf8" }, {});
  const custom = Object.assign(Object.create({}), { encoding: "utf8" });
  const expected = await nativeReadFile(f.message, "utf8");
  const probe = f.observe(); t.after(() => probe.stop());
  const thrown = await probe.capture(() => rejection(() => fs.readFile(f.message, getter)));
  assert.equal(thrown.result, sentinel); assert.equal(thrown.stateReads, 0);
  for (const options of [proxy, custom]) {
    const actual = await probe.capture(() => fs.readFile(f.message, options));
    assert.equal(actual.result, expected); assert.equal(actual.readBytes, 0);
  }
  for (const input of [Buffer.from(f.message), foreign]) {
    const actual = await probe.capture(() => fs.readFile(input));
    assert.deepEqual(actual.result, Buffer.from([65, 0xc3, 0xa9, 0xff, 66])); assert.equal(actual.stateReads, 0);
  }
});

test("binary falsy options and write flags retain native results and effects", async t => {
  const f = await fixture(t);
  const options = ["", { encoding: "" }, null, undefined];
  const expected = await Promise.all(options.map(option => nativeReadFile(f.message, option)));
  const probe = f.observe(); t.after(() => probe.stop());
  for (let i = 0; i < options.length; i++) {
    const actual = await probe.capture(() => fs.readFile(f.message, options[i]));
    assert.deepEqual(actual.result, expected[i]); reads(actual, 1, 5);
  }
  const truncated = await probe.capture(() => fs.readFile(f.message, { flag: "w+", encoding: "utf8" }));
  assert.equal(truncated.result, ""); reads(truncated, 1, 0);
  assert.deepEqual(await nativeReadFile(f.message), Buffer.alloc(0));
});

const fsNames = ["open", "readFile", "stat", "lstat", "readdir", "realpath", "rename", "link", "unlink", "mkdir", "rm"];
const descriptors = (object, names) => names.map(name => Object.getOwnPropertyDescriptor(object, name));
function restored(handle, reference) {
  assert.deepEqual(descriptors(handle, methods), methods.map(() => undefined));
  assert.deepEqual(methods.map(method => handle[method]), reference);
}

test("stop restores fs/named exports and every retained handle descriptor, idempotently", async t => {
  const f = await fixture(t), referenceHandle = await nativeOpen(f.message, "r");
  const reference = methods.map(method => referenceHandle[method]); await referenceHandle.close();
  const before = descriptors(fs, fsNames), beforeNamed = namedReadFile;
  const namedBefore = fsNames.map(name => namedFs[name]);
  const probe = f.observe(); t.after(() => probe.stop());
  assert.notEqual(namedReadFile, beforeNamed);
  const handle = f.retain(await fs.open(f.message, "r"));
  assert.notEqual(handle.read, reference[1]);
  const closed = await fs.open(f.message, "r"); await closed.close();
  const savedWrapper = handle.readFile;
  await assert.rejects(probe.capture(() => { throw new Error("capture sentinel"); }), /capture sentinel/);
  reads(await probe.capture(() => fs.readFile(f.message)), 1, 5);
  probe.stop();
  assert.deepEqual(descriptors(fs, fsNames), before); assert.equal(namedReadFile, beforeNamed);
  restored(handle, reference); restored(closed, reference);
  assert.deepEqual(fsNames.map(name => namedFs[name]), namedBefore);
  const frozen = probe.snapshot();
  assert.deepEqual(await savedWrapper.call(handle), Buffer.from([65, 0xc3, 0xa9, 0xff, 66]));
  assert.deepEqual(probe.snapshot(), frozen);
  const later = f.observe();
  try { probe.stop(); assert.notEqual(fs.readFile, nativeReadFile); }
  finally { later.stop(); }
});

test("measurement success/failure and pending open/read stop restore without closing caller handles", async t => {
  const f = await fixture(t), referenceHandle = await nativeOpen(f.message, "r");
  const reference = methods.map(method => referenceHandle[method]); await referenceHandle.close();
  const before = descriptors(fs, fsNames), sentinel = new Error("measurement sentinel");
  for (const fail of [false, true, "read-error"]) {
    let handle;
    try {
      const operation = () => measureTransactionIO(f.root, async () => {
        handle = await fs.open(f.message, "r");
        await handle.readFile(fail === "read-error" ? "invalid-encoding" : undefined);
        if (fail) throw sentinel;
        return "success";
      });
      if (fail === "read-error") assert.equal((await rejection(operation)).code, "ERR_INVALID_ARG_VALUE");
      else if (fail) assert.equal(await rejection(operation), sentinel);
      else assert.equal((await operation()).result, "success");
      restored(handle, reference); assert.deepEqual(descriptors(fs, fsNames), before);
      assert.equal((await handle.stat()).size, 5);
    } finally { await handle?.close(); }
  }
  const probe = f.observe();
  const pending = fs.open(f.message, "r"), pendingRead = fs.readFile(f.message);
  probe.stop(); const frozen = probe.snapshot(), handle = await pending;
  try {
    await pendingRead; restored(handle, reference);
    assert.deepEqual(probe.snapshot(), frozen); assert.deepEqual(descriptors(fs, fsNames), before);
  } finally { await handle.close(); }
});
