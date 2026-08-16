import { assertPorts } from "./ports.mjs";

/**
 * Composition root for the domain services. Everything time- or
 * randomness-dependent arrives through a port, so behaviour is reproducible and
 * no module reaches for a global. Domain methods are added in later tasks.
 *
 * @param {{ store: object, clock: object, ids: object, policies?: object }} ports
 */
export function createCoordinationService({ store, clock, ids, policies = {} }) {
  assertPorts({ store, clock, ids });
  return Object.freeze({
    store,
    clock,
    ids,
    policies: Object.freeze({ ...policies }),
  });
}
