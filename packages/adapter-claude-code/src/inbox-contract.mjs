// The facts of the inbox transport every module of it shares, kept apart so
// the endpoint record and the delivery methods import them without a cycle.

export const PROTOCOL_CONTRACT = "claude-code-inbox-socket-v1";
// The first release the inbox wake was captured on. 2.1.224 binds the socket,
// but only 2.1.282 was observed firing UserPromptSubmit for a delivered frame,
// and that is what brings the message body in with the wake.
export const MIN_VERSION = "2.1.282";
export const INBOX_MODES = Object.freeze(["livePush", "idleWake", "busyQueue"]);
export const TRANSPORT = "claude-inbox";
