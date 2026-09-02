import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { evaluateNativeEligibility } from "@agents-can-communicate/adapter-sdk";

// The launch-time check behind an owned shell shim. It answers one closed
// question - may this exact executable receive native delivery? - from the
// static minimum, a read-only adapter probe, and a keyed cache under ACC's own
// data home. It never throws: a shim that cannot decide launches the vendor
// command untouched, and this module is what makes "cannot decide" cheap.
//
// The cache key is the executable's identity - resolved path, symlink target,
// inode, size, mtime, and full sha256 - so an upgrade or replacement is a miss
// and an unchanged binary skips the version spawn and the probe. A cached
// failure is short-lived; a repaired client is never disabled for long.

export const BOOTSTRAP_CACHE_SCHEMA = 1;
export const SUPPORTED_TTL_MS = 6 * 60 * 60 * 1_000;
export const FAILED_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 750;
const VERSION = /(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\b|$)/;

export const cachePathFor = (dataHome, adapterId) =>
  path.join(dataHome, "acc", "native-bootstrap", `${adapterId}.json`);

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", chunk => hash.update(chunk))
      .on("error", reject).on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

async function executableIdentity(realExecutable) {
  const target = await realpath(realExecutable);
  const facts = await stat(target);
  if (!facts.isFile()) throw new Error("not a file");
  return { path: realExecutable, target, inode: facts.ino, size: facts.size,
    mtimeMs: Math.floor(facts.mtimeMs), executableFingerprint: await sha256File(target) };
}

function withTimeout(work, ms, label) {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`),
      { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

// Read-only: the client's own version command, nothing else.
export function defaultReadVersion({ realExecutable, versionArgs, timeoutMs }) {
  return new Promise(resolve => {
    execFile(realExecutable, versionArgs, { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) return resolve(null);
        resolve(VERSION.exec(`${stdout}${stderr}`)?.[1] ?? null);
      });
  });
}

const sameIdentity = (left, right) => left !== undefined && right !== undefined
  && ["path", "target", "inode", "size", "mtimeMs", "executableFingerprint"]
    .every(key => left[key] === right[key]);

async function loadCache(file) {
  try {
    const record = JSON.parse(await readFile(file, "utf8"));
    return record?.schemaVersion === BOOTSTRAP_CACHE_SCHEMA ? record : null;
  } catch {
    return null;
  }
}

async function saveCache(file, record) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const closedOutcome = (supported, reasonCode) => Object.freeze({ supported, reasonCode });

export async function checkNativeBootstrap({ adapter, realExecutable, platform, dataHome,
  timeoutMs = DEFAULT_TIMEOUT_MS, clock = { now: () => new Date().toISOString() },
  readVersion = defaultReadVersion }) {
  try {
    if (adapter?.nativeDelivery === undefined || typeof adapter.probeNativeDelivery !== "function") {
      return closedOutcome(false, "native_delivery_unsupported");
    }
    const identity = await executableIdentity(realExecutable);
    const file = cachePathFor(dataHome, adapter.id);
    const now = Date.parse(clock.now());
    const cached = await loadCache(file);
    if (cached !== null && cached.adapterId === adapter.id && cached.platform === platform
      && sameIdentity(cached.identity, identity) && Date.parse(cached.expiresAt) > now) {
      return closedOutcome(cached.supported, cached.reasonCode);
    }

    const clientVersion = await withTimeout(readVersion({ realExecutable: identity.target,
      versionArgs: adapter.client?.versionArgs ?? ["--version"], timeoutMs }), timeoutMs,
    "version probe").catch(() => null);
    let probe = null;
    let reasonCode = null;
    if (clientVersion !== null) {
      try {
        probe = await withTimeout(adapter.probeNativeDelivery({ realExecutable: identity.target,
          timeoutMs }), timeoutMs, "native probe");
      } catch (error) {
        probe = null;
        reasonCode = error?.code === "ETIMEDOUT" ? "probe_timeout" : "feature_probe_failed";
      }
    }
    let eligibility;
    try {
      eligibility = evaluateNativeEligibility(adapter, { clientVersion, platform, probe });
    } catch {
      // A malformed probe is an adapter bug, and still not a reason to change
      // the user's launch: it fails closed like any other probe failure.
      eligibility = { eligible: false, reasonCode: "feature_probe_failed" };
    }
    const supported = eligibility.eligible === true;
    // A probe that timed out or threw is reported as such rather than as the
    // generic verdict the missing probe would otherwise produce.
    const outcomeReason = supported ? null : (reasonCode ?? eligibility.reasonCode
      ?? "feature_probe_failed");
    // Only closed facts are stored: identity, versions, the eligibility verdict.
    // Never command output, never a message body.
    await saveCache(file, {
      schemaVersion: BOOTSTRAP_CACHE_SCHEMA, adapterId: adapter.id, platform, identity,
      clientVersion, supported, reasonCode: outcomeReason,
      protocolContract: supported ? eligibility.protocolContract : null,
      modes: supported ? [...eligibility.modes] : [],
      checkedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (supported ? SUPPORTED_TTL_MS : FAILED_TTL_MS)).toISOString(),
    }).catch(() => null);
    return closedOutcome(supported, outcomeReason);
  } catch {
    return closedOutcome(false, "feature_probe_failed");
  }
}
