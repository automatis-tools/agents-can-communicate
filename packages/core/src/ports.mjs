import { AccError, EXIT } from "@agents-can-communicate/protocol";

/**
 * @typedef {{ now(): string }} Clock
 * @typedef {{ next(kind: string): string }} IdSource
 * @typedef {{ get(kind: string, id: string): object | null,
 *   generationOf(kind: string, id: string): string | null,
 *   list(kind: string, predicate?: (record: object) => boolean): object[],
 *   put(kind: string, id: string, record: object, expectedGeneration?: string | null): string,
 *   append(event: object): object }} CoordinationTransaction
 * @typedef {{ transaction(callback: (tx: CoordinationTransaction) => unknown): Promise<unknown>,
 *   eventsSince(workspaceId: string, cursor: string | null, limit: number): Promise<object>,
 *   snapshot(workspaceId: string): Promise<object> }} CoordinationStore
 */

const REQUIRED = Object.freeze({
  store: ["transaction", "eventsSince", "snapshot"],
  clock: ["now"],
  ids: ["next"],
});

// Ephemeral records - presence and Intent before a workspace has materialised -
// are storage too, so they hang off the store rather than becoming a fourth
// port. They are deliberately outside transactions: they append no events and
// vanish with their session.
const EPHEMERAL = ["get", "put", "update", "delete", "list"];

// Ports are validated at construction rather than at first use. A core that
// silently falls back to ambient time or randomness produces tests that pass
// for the wrong reason and races that only appear on someone else's machine.
export function assertPorts(ports) {
  for (const [name, methods] of Object.entries(REQUIRED)) {
    const port = ports[name];
    if (port === null || typeof port !== "object") {
      throw new AccError(EXIT.USAGE, `the ${name} port is required`, { port: name });
    }
    for (const method of methods) {
      if (typeof port[method] !== "function") {
        throw new AccError(EXIT.USAGE, `the ${name} port must implement ${method}()`,
          { port: name, method });
      }
    }
  }
  const ephemeral = ports.store.ephemeral;
  if (ephemeral === null || typeof ephemeral !== "object") {
    throw new AccError(EXIT.USAGE, "the store port must expose an ephemeral area",
      { port: "store" });
  }
  for (const method of EPHEMERAL) {
    if (typeof ephemeral[method] !== "function") {
      throw new AccError(EXIT.USAGE, `the store ephemeral area must implement ${method}()`,
        { port: "store.ephemeral", method });
    }
  }
  // A bare function, not an object with methods, so it does not fit REQUIRED
  // above. Checked here for the same reason as everything else in this file: a
  // core that constructed cleanly and only discovered the gap at the first
  // presence check would raise a bare TypeError from deep inside sessions.mjs,
  // not an AccError - invisible to the CLI's exit-code mapping.
  if (typeof ports.pidIsAlive !== "function") {
    throw new AccError(EXIT.USAGE, "the pidIsAlive port must be a function",
      { port: "pidIsAlive" });
  }
  return ports;
}
