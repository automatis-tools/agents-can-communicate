import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

/**
 * Asking npm whether there is a newer ACC.
 *
 * This is the only part of ACC that touches the network, and it is kept to one
 * file for that reason. It is never on the hook path: a hook runs every turn
 * inside a five-second budget and fails open, so a stalled socket there would
 * cost every turn on the machine something and report nothing. `acc update`
 * asks, `acc doctor` reads what was cached, and the answer is remembered for a
 * day so a diagnostic run does not become traffic.
 *
 * `ACC_NO_UPDATE_CHECK=1` turns it off entirely, and then it says it is off
 * rather than saying the version is current.
 */
const REGISTRY = "https://registry.npmjs.org/agents-can-communicate/latest";
const EVERY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 3_000;

const cacheFile = dataHome => path.join(dataHome, "acc", "update-check.json");

export const checkingIsOff = env => {
  const value = env?.ACC_NO_UPDATE_CHECK;
  return value !== undefined && value !== "" && value !== "0";
};

const numbers = version => (typeof version === "string"
  ? version.trim().split("-", 1)[0].split(".") : [])
  .map(part => Number.parseInt(part, 10));

/**
 * Whether `candidate` is a later release than `current`.
 *
 * Anything unreadable is not newer. Telling somebody to upgrade because a
 * version could not be parsed is worse than saying nothing.
 */
export function isNewer(candidate, current) {
  const left = numbers(candidate);
  const right = numbers(current);
  if (left.length === 0 || left.some(Number.isNaN)) return false;
  if (right.length === 0 || right.some(Number.isNaN)) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index] ?? 0;
    const other = right[index] ?? 0;
    if (one !== other) return one > other;
  }
  return false;
}

/** Whether a remembered answer is old enough to ask again. */
export function checkDue({ checkedAt, now, everyMs = EVERY_MS }) {
  const last = Date.parse(checkedAt ?? "");
  return !Number.isFinite(last) || now - last >= everyMs;
}

export async function readCachedCheck(dataHome, { readFile }) {
  try {
    const cached = JSON.parse(await readFile(cacheFile(dataHome), "utf8"));
    return { latest: cached.latest ?? null, checkedAt: cached.checkedAt ?? null };
  } catch {
    // A missing or unreadable note is the same as never having asked.
    return { latest: null, checkedAt: null };
  }
}

export async function writeCachedCheck(dataHome, entry, { writeFile, mkdir }) {
  const file = cacheFile(dataHome);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`);
}

/** Ask the registry. The one network call in the product. */
export async function fetchLatest({ get = fetch, url = REGISTRY,
  timeoutMs = TIMEOUT_MS } = {}) {
  const response = await get(url, { signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" } });
  if (response?.ok !== true) {
    throw new AccError(EXIT.DATA, `the registry answered ${response?.status ?? "nothing"}`,
      { url });
  }
  const body = await response.json();
  if (typeof body?.version !== "string" || numbers(body.version).some(Number.isNaN)) {
    throw new AccError(EXIT.DATA, "the registry did not answer with a version", { url });
  }
  return body.version;
}

/**
 * What `acc doctor` says about a newer release, without becoming a network
 * command.
 *
 * The answer is remembered for a day, so running the diagnostic twice does not
 * ask twice. A registry that cannot be reached changes nothing: doctor is about
 * this machine, and a network that is down is not a fault in this install.
 */
export async function noticeUpdate({ dataHome, running, env, now, get, io }) {
  if (checkingIsOff(env)) return { checked: false, latest: null, newer: false };

  const cached = await readCachedCheck(dataHome, io);
  let latest = cached.latest;
  if (checkDue({ checkedAt: cached.checkedAt, now })) {
    try {
      latest = await fetchLatest({ get });
      await writeCachedCheck(dataHome,
        { latest, checkedAt: new Date(now).toISOString() }, io);
    } catch {
      latest = cached.latest;
    }
  }
  return { checked: true, latest: latest ?? null, newer: isNewer(latest, running) };
}
