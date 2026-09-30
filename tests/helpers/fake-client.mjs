// A stand-in for a client binary on PATH, in the form the platform runs: an
// executable shell script on POSIX, a `.cmd` on Windows, where ACC finds a
// command through PATHEXT and starts a `.cmd` through cmd.exe.
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

const windows = process.platform === "win32";
const shellLiteral = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * `output`: the one line the client prints, as a version probe expects.
 * `script`: JavaScript the client runs instead, with the arguments it was given
 * in process.argv.slice(2) and its environment in process.env.
 * Returns the path a lookup on PATH finds.
 */
export async function writeFakeClient(directory, name, { output, script } = {}) {
  if (script !== undefined) {
    const source = path.join(directory, `${name}.fake.mjs`);
    await writeFile(source, script);
    if (windows) {
      const file = path.join(directory, `${name}.cmd`);
      await writeFile(file, `@echo off\r\n"${process.execPath}" "${source}" %*\r\n`);
      return file;
    }
    const file = path.join(directory, name);
    await writeFile(file, `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(source)} "$@"\n`);
    await chmod(file, 0o755);
    return file;
  }
  if (typeof output !== "string") throw new Error("a fake client needs output or a script");
  if (windows) {
    if (/[%^&|<>!"]/.test(output)) throw new Error(`cmd cannot echo ${output}`);
    const file = path.join(directory, `${name}.cmd`);
    await writeFile(file, `@echo off\r\necho ${output}\r\n`);
    return file;
  }
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\nprintf '%s\\n' ${shellLiteral(output)}\n`);
  await chmod(file, 0o755);
  return file;
}

/** A PATH that holds `directory` and what the platform needs to run a fake. */
export function fakePath(directory) {
  return windows ? [directory, path.dirname(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")]
    .join(path.delimiter) : [directory, "/usr/bin", "/bin"].join(path.delimiter);
}
