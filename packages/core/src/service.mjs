import { createClaimService } from "./claims.mjs";
import { createConversationService } from "./conversations.mjs";
import { createDeliveryBindingService } from "./delivery-bindings.mjs";
import { createIntentService } from "./intents.mjs";
import { createInboxService } from "./inbox.mjs";
import { defaultPidIsAlive } from "./pid.mjs";
import { assertPorts } from "./ports.mjs";
import { createReceiptService } from "./receipts.mjs";
import { createSessionService } from "./sessions.mjs";
import { createGuardStateService, createStatusService } from "./status.mjs";
import { createSyncService } from "./sync.mjs";

/**
 * Composition root for the domain services. Everything time- or
 * randomness-dependent arrives through a port, so behaviour is reproducible and
 * no module reaches for a global.
 *
 * @param {{ store: object, clock: object, ids: object, pidIsAlive?: function,
 *   policies?: object }} ports
 */
export function createCoordinationService({ store, clock, ids,
  pidIsAlive = defaultPidIsAlive, policies = {} }) {
  // Defaulted here, where the default is a real implementation, and required in
  // the classifier, where a default could only be a lie. Passed into
  // assertPorts rather than spread on afterward, so an explicit non-function -
  // `null` included, since the default above only applies to `undefined` - is
  // shape-checked at construction like every other port instead of surfacing
  // as a raw TypeError the first time presence is classified.
  const ports = assertPorts({ store, clock, ids, pidIsAlive });
  const sessions = createSessionService(ports);
  const intents = createIntentService(ports, sessions);
  const claims = createClaimService(ports, sessions);
  const conversations = createConversationService(ports, sessions);
  const deliveryBindings = createDeliveryBindingService(ports, sessions);
  const inbox = createInboxService(ports, sessions);
  const receipts = createReceiptService(ports);
  const sync = createSyncService(ports, sessions);
  const status = createStatusService(ports, sessions, deliveryBindings);
  const guardState = createGuardStateService(ports);
  return Object.freeze({
    store,
    clock,
    ids,
    policies: Object.freeze({ ...policies }),
    ...sessions,
    ...intents,
    ...claims,
    ...conversations,
    publishDeliveryBinding: deliveryBindings.publishDeliveryBinding,
    listDeliveryBindings: deliveryBindings.listDeliveryBindings,
    ...inbox,
    ...receipts,
    ...sync,
    ...status,
    guardState,
  });
}
