// Shared pieces of the cost probes (#304). Nothing here knows an algorithm: a
// probe describes a scenario, builds a fixture with the side's own code, and
// proves the useful work from the scenario alone.
import { createHash } from "node:crypto";

const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;

/** JSON with keys in order, so equal values always hash alike. */
export const canonical = value => JSON.stringify(sorted(value));
export const digest = value => createHash("sha256")
  .update(typeof value === "string" ? value : canonical(value)).digest("hex");

/** A seeded generator (mulberry32): the same seed builds the same fixture on every side. */
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy: the order depends on the seed, never on an engine's sort. */
export function shuffle(items, next) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/** An array that counts its element reads into counter[key] and returns what the array holds. */
export function counted(array, counter, key) {
  counter[key] = 0;
  return new Proxy(array, { get(target, property, receiver) {
    if (typeof property === "string" && /^\d+$/.test(property)) counter[key] += 1;
    return Reflect.get(target, property, receiver);
  } });
}

/** Differences between two multisets of canonical keys, as readable failures. */
export function multisetFailures(expected, actual, label) {
  const counts = new Map();
  for (const key of expected) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const key of actual) counts.set(key, (counts.get(key) ?? 0) - 1);
  const failures = [];
  for (const [key, count] of counts) {
    if (count > 0) failures.push(`${label}: missing ${count} x ${key}`);
    if (count < 0) failures.push(`${label}: unexpected ${-count} x ${key}`);
  }
  return failures;
}

export const pad = (value, width = 6) => String(value).padStart(width, "0");
