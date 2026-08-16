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
  return ports;
}
