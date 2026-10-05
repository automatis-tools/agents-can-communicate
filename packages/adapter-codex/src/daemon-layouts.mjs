// The two packages a Codex daemon runs from, measured. The standalone install
// keeps its PID in app-server.pid (0.154.0-0.159.0); a home with no standalone
// package gets the daemon's own package from `app-server daemon start` on
// 0.157.1 and newer, with its PID in daemon.pid (0.159.0, 2026-09-29). A home
// that has the standalone package keeps using it, so it is looked for first.
export const DAEMON_LAYOUTS = Object.freeze([
  { name: "standalone", packageDir: "packages/standalone",
    executables: ["current/bin/codex", "current/codex", "current/bin/codex.exe"],
    pidFile: "app-server-daemon/app-server.pid" },
  { name: "self-installed", packageDir: "packages/app-server-daemon",
    executables: ["current/bin/codex", "current/bin/codex.exe"],
    pidFile: "app-server-daemon/daemon.pid" },
]);
