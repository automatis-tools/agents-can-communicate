// The facts of the `kimi web` transport every module of it shares, kept apart
// so the endpoint record and the delivery methods import them without a cycle.
// Shapes are read from the 2.4.0 sources (kap-server instanceRegistry,
// sessionLockService, routes/meta, routes/prompts), not guessed.

export const PROTOCOL_CONTRACT = "kimi-web-prompt-wake-v1";
// The first release with the kap-server instance registry, session locks and
// the authenticated /api/v1/meta handshake this transport verifies.
export const MIN_VERSION = "2.4.0";
// No busyQueue capability claim yet. A wake the server queues behind active
// work is reported with queueStatus from the POST itself, never as woken;
// the 2.4.0 GET snapshot is not a reliable pre-submit busy oracle.
export const WEB_MODES = Object.freeze(["livePush", "idleWake"]);
export const TRANSPORT = "kimi-web";

// kap-server heartbeats its instance file every 15 s; three missed intervals
// is a dead server that has not been swept yet.
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_FRESH_MS = 3 * HEARTBEAT_INTERVAL_MS;
// The session lock format is internal and versioned; only version 1 is read,
// anything else fails closed rather than assuming stability.
export const LOCK_FILE_VERSION = 1;
export const WEB_DISPLAY_NAME = "Kimi Code Web";
// A loopback server only: a published host of anything else is not an
// endpoint ACC may send prompts to.
export const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "::1"]);
// session ids are ulids/uuids; the pattern also keeps one out of a path.
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
export const SERVER_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
