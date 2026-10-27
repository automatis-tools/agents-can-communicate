// Resolve every ref's content/history facts before conservatively joining trees.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { checkoutMatchesCommit } from "./push-tree-check.mjs";
import { stopPushProcessTree, terminationFailure } from "./push-process-tree.mjs";

const run = promisify(execFile);
const zero = oid => /^0+$/.test(oid);
export function pushEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|QUARANTINE_PATH)$/i.test(key)) delete env[key];
  return env;
}
export async function pushGit(repo, args) {
  return (await run("git", ["--no-replace-objects", "-C", repo, ...args],
    { env: { ...pushEnvironment(), GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024 })).stdout;
}
export function parsePushRefs(text, { objectFormat }) {
  const width = { sha1: 40, sha256: 64 }[objectFormat];
  if (!width) throw Error("unsupported push object format");
  const oid = new RegExp(`^[0-9a-f]{${width}}$`);
  return text.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const fields = line.trim().split(/\s+/);
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    if (fields.length !== 4 || !oid.test(localOid) || !oid.test(remoteOid)
      || !localRef || /^[-\x00-\x20]/.test(localRef) || /[\x00-\x1f\x7f]/.test(localRef)
      || !/^refs\/[^\s]+$/.test(remoteRef) || /[\x00-\x1f\x7f]/.test(remoteRef)) {
      throw Error("malformed push ref input");
    }
    return { localRef, localOid, remoteRef, remoteOid };
  });
}
export async function resolvePushTrees(repo, refs) {
  const resolved = [];
  for (const ref of refs) {
    try { await pushGit(repo, ["check-ref-format", ref.remoteRef]); }
    catch { throw Error("malformed push ref name"); }
    if (zero(ref.localOid)) continue;
    let commit;
    let tree;
    try {
      commit = (await pushGit(repo, ["rev-parse", "--verify", `${ref.localOid}^{commit}`])).trim();
      tree = (await pushGit(repo, ["rev-parse", "--verify", `${commit}^{tree}`])).trim();
    } catch { throw Error(`unresolved pushed commit ${ref.localOid}`); }
    let ancestryVerified = true;
    let complete = true;
    if (!zero(ref.remoteOid)) {
      let base;
      try { base = (await pushGit(repo, ["rev-parse", "--verify", `${ref.remoteOid}^{commit}`])).trim(); }
      catch { throw Error(`unresolved remote base ${ref.remoteOid}`); }
      try { await pushGit(repo, ["merge-base", "--is-ancestor", base, commit]); }
      catch { ancestryVerified = false; }
      try { await pushGit(repo, ["diff", "--raw", "--no-ext-diff", base, commit, "--"]); }
      catch { complete = false; }
    } else {
      try { await pushGit(repo, ["diff-tree", "--root", "--raw", "--no-commit-id", "-r", commit]); }
      catch { complete = false; }
    }
    const requiredScope = ref.remoteRef.startsWith("refs/heads/measure/") && complete && ancestryVerified
      ? "measurement-only" : "full";
    resolved.push({ commit, tree, refs: [ref], requiredScope, checkout: "isolated" });
  }
  const joined = new Map();
  const rank = { "measurement-only": 0, docs: 1, full: 2 };
  for (const target of resolved) {
    const previous = joined.get(target.tree);
    if (!previous) joined.set(target.tree, target);
    else {
      previous.refs.push(...target.refs);
      if (rank[target.requiredScope] > rank[previous.requiredScope]) previous.requiredScope = target.requiredScope;
    }
  }
  for (const target of joined.values()) {
    if (await checkoutMatchesCommit(repo, target.commit)) target.checkout = "current";
  }
  return [...joined.values()];
}

// Best-effort cancellation of currently visible descendants, including detached
// batch groups. This cannot prove historical ownership of reparented workers.
// Never expose command environment or checkout paths.
// Optional executor/platform overrides are solely a command-boundary test seam;
// production always uses native spawn/platform and fixed taskkill arguments.
export function runPushCommand(file, args, { cwd, signal, input, quiet = false,
  platform = process.platform, spawnCommand = spawn, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error("push validation interrupted")); return; }
    const windows = platform === "win32";
    const child = spawnCommand(file, args, { cwd, env: { ...pushEnvironment(), ...env }, detached: !windows,
      shell: windows && file === "npm", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let cancellation = Promise.resolve();
    const abort = () => {
      if (windows) {
        cancellation = new Promise(resolve => {
          if (!Number.isInteger(child.pid) || child.pid <= 0) { resolve(terminationFailure()); return; }
          let killer;
          try { killer = spawnCommand("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }); }
          catch { resolve(terminationFailure()); return; }
          const timeout = setTimeout(() => { killer.unref?.(); resolve(terminationFailure()); }, 2000);
          killer.once("error", () => { clearTimeout(timeout); resolve(terminationFailure()); });
          killer.once("close", code => { clearTimeout(timeout); resolve(code === 0 ? null : terminationFailure()); });
        });
      }
      else cancellation = stopPushProcessTree(child.pid);
      // Teardown completion, not inherited pipe closure, bounds cancellation.
      // The checkout owner retains interrupted resources even after confirmed kills.
      cancellation.then(error => {
        child.unref?.();
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
        reject(error ?? Error("push validation interrupted"));
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("error", error => { signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", async code => {
      signal?.removeEventListener("abort", abort);
      const terminationError = await cancellation;
      if (terminationError) { reject(terminationError); return; }
      if (!quiet) {
        const roots = [...new Set([cwd, await realpath(cwd).catch(() => cwd)])].sort((a, b) => b.length - a.length);
        const relative = text => {
          for (const root of roots) text = text.replaceAll(pathToFileURL(`${root}${path.sep}`).href, "")
            .replaceAll(`${root}${path.sep}`, "").replaceAll(root, ".");
          return text.replaceAll(homedir(), "~");
        };
        process.stdout.write(relative(stdout));
        process.stderr.write(relative(stderr));
      }
      if (signal?.aborted) reject(Error("push validation interrupted"));
      else if (code !== 0) reject(Error(quiet ? "target dependency preparation failed" : "target content gate failed"));
      else resolve();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Validation interruption handling ends only after the final byte audit and
// abort decision. Cleanup then commits with those handlers removed; later
// signals follow caller/OS behavior, not interrupted-validation retention.
export async function withPushCheckout(repo, target, callback) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let owned;
  let checkout;
  let registered = false;
  let cleanupAllowed = true;
  try {
    if (target.checkout === "current" && await checkoutMatchesCommit(repo, target.commit)) checkout = repo;
    else {
      owned = await mkdtemp(path.join(tmpdir(), "acc-push-checkout-"));
      checkout = path.join(owned, "tree");
      await pushGit(repo, ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "worktree", "add", "--detach", checkout, target.commit]);
      registered = true;
      if (!await checkoutMatchesCommit(checkout, target.commit)) throw Error("unsupported pushed checkout topology");
      await runPushCommand("npm", ["ci", "--no-audit", "--no-fund"], { cwd: checkout, signal: controller.signal, quiet: true });
      if (!await checkoutMatchesCommit(checkout, target.commit)) throw Error("target changed during dependency preparation");
    }
    if (controller.signal.aborted) throw Error("push validation interrupted");
    await callback(checkout, controller.signal);
    if (controller.signal.aborted) throw Error("push validation interrupted");
    if (!await checkoutMatchesCommit(checkout, target.commit)) throw Error("target changed during validation");
    if (controller.signal.aborted) throw Error("push validation interrupted");
  } catch (error) {
    if (error.code === "PUSH_TERMINATION_UNCONFIRMED") cleanupAllowed = false;
    if (owned && controller.signal.aborted) {
      cleanupAllowed = false;
      if (error.code !== "PUSH_TERMINATION_UNCONFIRMED") {
        throw Error("push validation interrupted; owned checkout retained for recovery", { cause: error });
      }
    }
    throw error;
  } finally {
    // Commit to cleanup synchronously before its first destructive await.
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (owned && cleanupAllowed && !controller.signal.aborted) {
      try { if (registered) await pushGit(repo, ["worktree", "remove", "--force", checkout]); }
      finally { await rm(owned, { recursive: true, force: true, maxRetries: 5 }); }
    }
  }
}
