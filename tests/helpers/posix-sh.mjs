// A hook command in the POSIX form is `sh <shim> <kind>`, and the client runs it
// through /bin/sh. These helpers ask /bin/sh itself which words it reads, with
// printf in place of the leading `sh`, so the quoting is tested and nothing runs.
import { execFileSync } from "node:child_process";

export const POSIX_SH = process.platform === "win32"
  ? "the POSIX form of a hook command runs through /bin/sh" : false;

// A directory name with everything /bin/sh acts on inside double quotes, and a
// space: a quote, a backslash, $ and a backtick.
export const SHELL_HOSTILE = "acc sh $HOME `echo x` \\ \"q\"-";

export const shWords = command => execFileSync("/bin/sh",
  ["-c", command.replace(/^sh /, "printf '%s\\n' ")], { encoding: "utf8" })
  .split("\n").slice(0, -1);
