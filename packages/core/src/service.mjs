import { createIntentService } from "./intents.mjs";
import { assertPorts } from "./ports.mjs";
import { createSessionService } from "./sessions.mjs";

/**
 * Composition root for the domain services. Everything time- or
 * randomness-dependent arrives through a port, so behaviour is reproducible and
 * no module reaches for a global.
 *
 * @param {{ store: object, clock: object, ids: object, policies?: object }} ports
 */
export function createCoordinationService({ store, clock, ids, policies = {} }) {
  const ports = assertPorts({ store, clock, ids });
  const sessions = createSessionService(ports);
  const intents = createIntentService(ports, sessions);
  return Object.freeze({
    store,
    clock,
    ids,
    policies: Object.freeze({ ...policies }),
    ...sessions,
    ...intents,
  });
}
