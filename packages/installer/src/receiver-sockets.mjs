import path from "node:path";

/**
 * Every Unix socket path ACC can deliver to on this machine.
 *
 * A sender whose client sandboxes its shell - Codex - has to be allowed to
 * connect to the recipient's socket, and the recipient's adapter is the only
 * one that knows where that socket lives. Each adapter declares its own through
 * `inboundSockets(context)`; the sender's adapter receives the composed list as
 * `context.receiverSockets` and never names another vendor's paths itself.
 *
 * Composed from every known adapter, not the ones an install names: installing
 * Codex alone must still allow a Claude Code session installed before or after.
 */
export function receiverSockets(adapters, context) {
  const paths = [...adapters].flatMap(adapter =>
    typeof adapter.inboundSockets === "function" ? adapter.inboundSockets(context) ?? [] : []);
  return [...new Set(paths.filter(item => typeof item === "string" && path.isAbsolute(item)))].sort();
}
