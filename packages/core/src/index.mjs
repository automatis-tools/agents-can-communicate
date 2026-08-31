// Domain services over injected ports. No vendor, Git, or project knowledge.
export { createCoordinationService } from "./service.mjs";
export { assertPorts } from "./ports.mjs";
export { classifySessionPresence } from "./sessions.mjs";
export { defaultPidIsAlive } from "./pid.mjs";
export { ATTENTION_PRIORITY, computeAttention } from "./sync.mjs";
export { looksConsequential } from "./message-signals.mjs";
export { overlaps } from "./claims.mjs";
export { wouldCycle } from "./tasks.mjs";
