import path from "node:path";

import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { encode, publishAtomic, readJsonIfPresent } from "./atomic-json.mjs";

const SEQUENCE = /^[0-9]{16}$/;

/**
 * The highest event sequence this store has trimmed away.
 *
 * Trimming the oldest events is safe on its own, because `nextSequence` reads
 * the newest file. An emptied directory is what needs a floor: without one the
 * sequence would restart at 1 and collide with a cursor a peer still holds,
 * and a reader whose cursor precedes the boundary would be served a short page
 * with no way to tell it was short.
 */
const floorPath = paths => path.join(paths.locks, "retention.json");

export function assertSequence(value, field) {
  if (typeof value !== "string" || !SEQUENCE.test(value)) {
    throw new AccError(EXIT.USAGE,
      `${field} is the 16-digit sequence a previous sync returned`, { [field]: value });
  }
  return value;
}

// An unreadable floor is treated as none. The alternative - refusing to serve
// events because the bookkeeping about their removal is damaged - would take a
// workspace offline over a file that only ever adds information.
export async function readEventFloor(paths, root) {
  const found = await readJsonIfPresent(floorPath(paths), root).catch(() => null);
  const value = found?.value?.trimmedThrough;
  return typeof value === "string" && SEQUENCE.test(value) ? value : null;
}

/**
 * Raise the floor, never lower it.
 *
 * Written before a single event file moves. A floor ahead of the trim only
 * reports a boundary for events still present, which costs a reader nothing;
 * a trim ahead of the floor is a silent gap, which is the failure this exists
 * to prevent.
 */
export async function raiseEventFloor(paths, options, trimmedThrough) {
  assertSequence(trimmedThrough, "trimmedThrough");
  const current = await readEventFloor(paths, options.root);
  if (current !== null && current >= trimmedThrough) return current;
  await publishAtomic(floorPath(paths), encode({ trimmedThrough }),
    { ...options, replace: true });
  return trimmedThrough;
}
