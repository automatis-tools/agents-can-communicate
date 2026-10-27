// Missing ref validation, premature tree deduplication, or trusting index flags
// would respectively break these independently specified Git fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture, invokePush, refLine } from "../helpers/push-fixture.mjs";
import { parsePushRefs, resolvePushTrees, runPushCommand, withPushCheckout } from "../../scripts/push-targets.mjs";
import { checkoutMatchesCommit } from "../../scripts/push-tree-check.mjs";

for (const format of ["sha1", "sha256"]) {
  test(`${format} refs parse strictly and resolve real objects`, async t => {
    const f = await fixture(t, format);
    const oid = await f.oid();
    const refs = parsePushRefs(refLine(oid), { objectFormat: format });
    assert.equal(refs[0].localOid, oid);
    assert.equal((await resolvePushTrees(f.root, refs))[0].commit, oid);
    for (const invalid of ["x", `${refLine(oid)} extra`, refLine("e".repeat(oid.length - 1)),
      refLine(oid).replace("refs/heads/main", "-bad")]) {
      assert.throws(() => parsePushRefs(invalid, { objectFormat: format }), /malformed push ref/);
    }
    await assert.rejects(resolvePushTrees(f.root, parsePushRefs(refLine("e".repeat(oid.length)),
      { objectFormat: format })), /unresolved pushed commit/);
  });
}

test("same-tree commits retain all ref bases and normal requirement before deduplication", async t => {
  const f = await fixture(t);
  const first = await f.oid();
  const second = await f.commit("same tree", true);
  const refs = parsePushRefs(`${refLine(first, "measure/probe")}\n${refLine(second, "normal", first)}`,
    { objectFormat: "sha1" });
  const targets = await resolvePushTrees(f.root, refs);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].refs.length, 2);
  assert.equal(targets[0].refs[1].remoteOid, first);
  assert.equal(targets[0].requiredScope, "full");
  refs[1].remoteOid = "e".repeat(40);
  await assert.rejects(resolvePushTrees(f.root, refs), /unresolved remote base/);
});

test("nonancestor bases conservatively require a suite even on measurement refs", async t => {
  const f = await fixture(t);
  const base = await f.oid();
  await writeFile(path.join(f.root, "one.txt"), "one");
  const left = await f.commit("left");
  await f.git(["checkout", "-q", base]);
  await writeFile(path.join(f.root, "two.txt"), "two");
  const right = await f.commit("right");
  const [target] = await resolvePushTrees(f.root,
    parsePushRefs(refLine(left, "measure/probe", right), { objectFormat: "sha1" }));
  assert.equal(target.requiredScope, "full");
});

test("byte verification refuses flags, extra inputs, modes and symlink changes without index mutation", async t => {
  const f = await fixture(t);
  const oid = await f.oid();
  assert.equal(await checkoutMatchesCommit(f.root, oid), true);
  await f.git(["update-index", "--assume-unchanged", "module.mjs"]);
  const index = path.resolve(f.root, (await f.git(["rev-parse", "--git-path", "index"])).stdout.trim());
  const beforeIndex = await readFile(index);
  assert.equal(await checkoutMatchesCommit(f.root, oid), false);
  assert.deepEqual(await readFile(index), beforeIndex, "verification rewrote the user index");
  await f.git(["update-index", "--no-assume-unchanged", "module.mjs"]);
  await f.git(["update-index", "--skip-worktree", "module.mjs"]);
  assert.equal(await checkoutMatchesCommit(f.root, oid), false);
  await f.git(["update-index", "--no-skip-worktree", "module.mjs"]);
  await writeFile(path.join(f.root, "extra.test.mjs"), "export {};\n");
  assert.equal(await checkoutMatchesCommit(f.root, oid), false);
  await f.remove("extra.test.mjs");
  if (process.platform !== "win32") {
    await chmod(path.join(f.root, "module.mjs"), 0o755);
    assert.equal(await checkoutMatchesCommit(f.root, oid), false);
    const executable = await f.commit("executable");
    assert.equal(await checkoutMatchesCommit(f.root, executable), true);
    await symlink("module.mjs", path.join(f.root, "link.mjs"));
    const linked = await f.commit("symlink");
    assert.equal(await checkoutMatchesCommit(f.root, linked), true);
    await f.remove("link.mjs");
    await symlink("target.test.mjs", path.join(f.root, "link.mjs"));
    assert.equal(await checkoutMatchesCommit(f.root, linked), false);
  }
});

test("owned checkouts are removed after failure while unrelated worktrees remain", async t => {
  const f = await fixture(t);
  const oid = await f.oid();
  const other = path.join(f.base, "unrelated");
  await f.git(["worktree", "add", "--detach", other, oid]);
  let owned;
  await assert.rejects(withPushCheckout(f.root, { commit: oid, checkout: "isolated" }, async checkout => {
    owned = checkout;
    assert.equal(await f.read("package.json", checkout).then(JSON.parse).then(p => p.name), "push-fixture");
    throw Error("target test failed");
  }), /target test failed/);
  assert.equal(await f.exists(owned), false);
  const listed = (await f.git(["worktree", "list", "--porcelain"])).stdout;
  assert.match(listed, /unrelated/);
  assert.equal(listed.match(/^worktree /gm).length, 2);
});

test("deletion-only pushes have no checkout or syntax dependency and malformed lines refuse", async t => {
  const f = await fixture(t);
  const oid = await f.oid();
  await writeFile(path.join(f.root, "module.mjs"), "export const = ;");
  const deletion = await invokePush(f, `(delete) ${"0".repeat(40)} refs/heads/gone ${oid}`);
  assert.equal(deletion.code, 0, deletion.stderr);
  assert.match(deletion.stdout, /deletions only/);
  const malformed = await invokePush(f, "malformed");
  assert.notEqual(malformed.code, 0);
  assert.match(malformed.stderr, /malformed push ref/);
});


test("interruption stops the target child and removes only its owned checkout", { timeout: 15000, skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  const oid = await f.oid();
  const helper = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/push-targets.mjs")).href;
  const marker = path.join(f.base, "child-started");
  const descendantMarker = path.join(f.base, "descendant-started");
  const descendantSource = `require("node:fs").writeFileSync(${JSON.stringify(descendantMarker)}, String(process.pid)); setInterval(()=>{},1000)`;
  const childSource = `const descendant=require("node:child_process").spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:'ignore'});
    process.on('SIGTERM',()=>{ descendant.once('exit',()=>process.exit(0)); setTimeout(()=>process.exit(0),3000); });
    require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000)`;
  const source = `import {withPushCheckout,runPushCommand} from ${JSON.stringify(helper)};
    try { await withPushCheckout(process.cwd(), {commit:${JSON.stringify(oid)},checkout:'isolated'}, async (cwd,signal) => {
      console.log('READY ' + cwd);
      await runPushCommand(process.execPath,['-e',${JSON.stringify(childSource)}],{cwd,signal});
    }); } catch(error) { console.error(error.message); process.exitCode=1; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.root, env: f.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const closed = new Promise(resolve => child.on("close", code => resolve(code)));
  let deadline;
  let pid;
  let descendant;
  let ownershipMonitor;
  let removedWhileAlive = false;
  try {
    await Promise.race([new Promise(resolve => child.stdout.on("data", () => {
      if (stdout.includes("READY ")) resolve();
    })), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error("helper did not start")), 10000); })]);
    clearTimeout(deadline);
    const owned = stdout.match(/READY (.+)/)[1].trim();
    const until = Date.now() + 5000;
    while (!await f.exists(marker) || !await f.exists(descendantMarker)) {
      assert.ok(Date.now() < until, "target child never became ready");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    pid = Number(await readFile(marker, "utf8"));
    descendant = Number(await readFile(descendantMarker, "utf8"));
    for (const ownedPid of [pid, descendant]) assert.doesNotThrow(() => process.kill(ownedPid, 0), "owned child/descendant never ran");
    ownershipMonitor = setInterval(async () => {
      if (await f.exists(owned)) return;
      for (const ownedPid of [pid, descendant]) {
        try { process.kill(ownedPid, 0); removedWhileAlive = true; } catch { /* Dead. */ }
      }
    }, 5);
    child.kill("SIGTERM");
    assert.notEqual(await closed, 0, "interruption was falsely successful");
    assert.match(stderr, /interrupted/);
    clearInterval(ownershipMonitor);
    for (const ownedPid of [pid, descendant]) assert.throws(() => process.kill(ownedPid, 0), /ESRCH/, "owned child/descendant survived cancellation");
    assert.equal(removedWhileAlive, false, "checkout was removed under a live owned descendant");
    assert.equal(await f.exists(owned), false);
    assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 1);
  } finally {
    clearTimeout(deadline);
    clearInterval(ownershipMonitor);
    child.kill("SIGTERM");
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* Already dead. */ } }
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* Already dead. */ } }
    await closed;
  }
});


test("unsupported sparse checkouts and ignored inputs cannot substitute for a clean target", async t => {
  const f = await fixture(t);
  const oid = await f.oid();
  await f.git(["config", "core.sparseCheckout", "true"]);
  assert.equal(await checkoutMatchesCommit(f.root, oid), false);
  await f.git(["config", "core.sparseCheckout", "false"]);
  const exclude = path.resolve(f.root, (await f.git(["rev-parse", "--git-path", "info/exclude"])).stdout.trim());
  await writeFile(exclude, "ignored.test.mjs\n");
  await writeFile(path.join(f.root, "ignored.test.mjs"), "export {};\n");
  assert.equal(await checkoutMatchesCommit(f.root, oid), false);
});


// Native forced Windows child.kill cannot deliver a graceful SIGTERM. This
// narrow executor seam instead tests taskkill ownership/completion ordering.
function controlledProcess(pid) {
  const child = new EventEmitter();
  return Object.assign(child, { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
}

test("Windows termination is awaited for the owned PID before command rejection", async () => {
  const target = controlledProcess(12345);
  const killer = controlledProcess(23456);
  const controller = new AbortController();
  const calls = [];
  const running = runPushCommand("npm", ["test"], { cwd: path.resolve(import.meta.dirname, "../.."),
    signal: controller.signal, quiet: true, platform: "win32", spawnCommand: (file, args, options) => {
      calls.push({ file, args, options });
      return calls.length === 1 ? target : killer;
    } });
  let settled = false;
  running.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  target.emit("close", 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "command settled before descendant termination completed");
  assert.equal(calls[0].options.shell, true);
  assert.equal(calls[1].file, "taskkill");
  assert.deepEqual(calls[1].args, ["/pid", "12345", "/t", "/f"]);
  killer.emit("close", 0);
  await assert.rejects(running, /push validation interrupted/);
});

for (const failure of ["error", "nonzero", "throw"]) {
  test(`Windows taskkill ${failure} is handled as unconfirmed termination`, async () => {
    const target = controlledProcess(12345);
    const killer = controlledProcess(23456);
    const controller = new AbortController();
    let calls = 0;
    const running = runPushCommand("npm", ["test"], { cwd: path.resolve(import.meta.dirname, "../.."),
      signal: controller.signal, quiet: true, platform: "win32", spawnCommand: () => {
        if (++calls === 1) return target;
        if (failure === "throw") throw Error("launch denied");
        return killer;
      } });
    controller.abort();
    if (failure === "error") assert.doesNotThrow(() => killer.emit("error", Error("launch denied")));
    else if (failure === "nonzero") killer.emit("close", 1);
    let deadline;
    try {
      await Promise.race([assert.rejects(running, error => error.code === "PUSH_TERMINATION_UNCONFIRMED"
        && /owned process termination unconfirmed/.test(error.message)), new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error("termination failure waited for a still-live child")), 500);
      })]);
    } finally { clearTimeout(deadline); target.emit("close", 1); }
  });
}


test("unconfirmed descendant termination retains the owned checkout for recovery", async t => {
  const f = await fixture(t);
  let owned;
  try {
    await assert.rejects(withPushCheckout(f.root, { commit: await f.oid(), checkout: "isolated" }, async checkout => {
      owned = checkout;
      throw Object.assign(Error("owned process termination unconfirmed"), { code: "PUSH_TERMINATION_UNCONFIRMED" });
    }), /termination unconfirmed/);
    assert.equal(await f.exists(owned), true, "checkout was removed without proven termination");
    assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 2);
  } finally {
    if (owned && await f.exists(owned)) {
      await f.git(["worktree", "remove", "--force", owned]);
      await import("node:fs/promises").then(fs => fs.rm(path.dirname(owned), { recursive: true, force: true }));
    }
  }
});
