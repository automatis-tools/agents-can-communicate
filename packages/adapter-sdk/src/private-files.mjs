import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

// Private records an adapter keeps beside a live endpoint: one user's, never
// reached through a link. POSIX keeps them to the owner with mode bits on each
// file and directory. Windows has none - Node reports every file as 0o666 - and
// keeps them private through the profile's ACL, checked for the data home once
// (docs/design/2026-09-30-native-windows-support.md, section 8).

export const isWindowsPlatform = platform => String(platform).startsWith("win32");

/** Whether `info` grants none of `mask` to others; always so on Windows. */
export const closedTo = (info, mask, { platform = process.platform } = {}) =>
  isWindowsPlatform(platform) || (info.mode & mask) === 0;

/**
 * Open a regular file without following a link at its name. Windows has no
 * O_NOFOLLOW, so the name is checked first and the handle after the open has to
 * hold the file the name named.
 */
export async function openRegularNoFollow(file, flags = constants.O_RDONLY,
  { platform = process.platform } = {}) {
  if (!isWindowsPlatform(platform)) {
    return open(file, flags | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  }
  const named = await lstat(file, { bigint: true });
  if (!named.isFile()) throw Object.assign(new Error(`not a regular file: ${file}`), { code: "EINVAL" });
  const handle = await open(file, flags);
  const opened = await handle.stat({ bigint: true }).catch(() => null);
  if (opened?.dev !== named.dev || opened?.ino !== named.ino) {
    await handle.close().catch(() => null);
    throw Object.assign(new Error(`replaced while opening: ${file}`), { code: "EINVAL" });
  }
  return handle;
}
