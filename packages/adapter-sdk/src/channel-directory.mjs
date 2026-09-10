import os from "node:os";
import path from "node:path";

// macOS Unix paths are capped at 104 bytes. A stable, short per-user namespace
// also lets a sandbox grant access regardless of each client's TMPDIR value.
export const channelSocketDirectory = () => path.join(
  process.platform === "darwin" ? "/tmp" : os.tmpdir(),
  `acc-ch-${typeof process.getuid === "function" ? process.getuid() : "u"}`);
