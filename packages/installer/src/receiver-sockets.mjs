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

/**
 * Whether any adapter's sessions receive on a loopback (127.0.0.1) listener.
 *
 * A sandboxed sender - Codex - allows network peers by domain, and a domain
 * rule cannot port-restrict: allowing a host allows every port on it. So the
 * sender's profile may name the exact literal 127.0.0.1 only, never a wildcard
 * or a private range, and only when a receiving adapter explicitly declares
 * `inboundLoopback(context) === true`. The sender's adapter receives the
 * composed boolean as `context.receiverLoopback`.
 */
export function receiverLoopback(adapters, context) {
  return [...adapters].some(adapter => typeof adapter.inboundLoopback === "function"
    && adapter.inboundLoopback(context) === true);
}
