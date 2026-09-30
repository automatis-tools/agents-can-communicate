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

// Install tests that check file names and command strings pin the POSIX form,
// so one expectation holds on every host; each adapter's Windows form has its
// own tests, and real clients run it on the Windows CI runner.
export const POSIX_FORM = "linux";

// Antigravity CLI matches an allow rule against a command's first word. On
// Windows the skill runs `node "<path>"`, and a rule on `node` would allow every
// node command, so ACC writes none there and each ACC command asks.
export const NO_ALLOW_RULE_ON_WINDOWS = process.platform === "win32"
  ? "Windows writes no allow rule: the command's first word is node" : false;

// ACC 0.7.x wrote `sh` shims and shell-profile blocks, and it never installed on
// Windows: its package's `os` field refused win32 with EBADPLATFORM (issue #234).
// A Windows machine holds no 0.7.x artefact for a current ACC to meet.
export const NO_LEGACY_ON_WINDOWS = process.platform === "win32"
  ? "ACC 0.7.x never installed on Windows, so no 0.7.x shim exists there" : false;
