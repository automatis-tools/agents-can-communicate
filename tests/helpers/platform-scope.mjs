// Tests of a POSIX-only transport. Live delivery on Windows - the Claude Code
// inbox pipe, the Codex daemon through its stdio proxy, the Antigravity relay on
// a named pipe - arrives in 0.9.x (docs/design/2026-09-30-native-windows-
// support.md, section 7). Until then Windows reports it unsupported, and these
// tests of the POSIX transport do not run there.
import nodeTest from "node:test";

export const POSIX_LIVE_TRANSPORT = process.platform === "win32"
  ? "live delivery on Windows arrives in 0.9.x; this tests its POSIX transport" : false;

/** `test` for a file of POSIX live-transport tests; same signatures as node:test. */
export function posixTransportTest(name, ...rest) {
  const fn = rest.pop();
  const options = rest[0] ?? {};
  return nodeTest(name, { ...options, skip: options.skip ?? POSIX_LIVE_TRANSPORT }, fn);
}
