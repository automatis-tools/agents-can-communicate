// Codes with which the filesystem refuses a process the writes admission needs:
// a client sandbox or host policy around ACC's data home, or files another user
// owns (#316). ChatGPT Work Mode refused an fchmod; a Codex chat without ACC's
// rules file refused the lock's mkdir. Both were then told an update was
// unfinished, while the runtime was ready and nothing was pending.
const DENIED = new Set(["EPERM", "EACCES", "EROFS"]);
// What the refused operation was, so a denied read is never called a refused
// write. `open` serves both, and its flags are not on the error.
const WRITES = new Set(["mkdir", "mkdtemp", "fchmod", "chmod", "lchmod", "chown", "fchown", "lchown", "rename",
  "unlink", "rmdir", "rm", "write", "writev", "fsync", "fdatasync", "truncate", "ftruncate", "link", "symlink",
  "utime", "futime", "lutime", "copyfile"]);
const READS = new Set(["lstat", "stat", "fstat", "realpath", "readdir", "scandir", "opendir", "read", "readv",
  "readlink", "access"]);
const accessOf = syscall => WRITES.has(syscall) ? "write" : READS.has(syscall) ? "read" : "access";
// Windows refuses a rename or removal of a directory something still holds
// open with EPERM: contention the lock retries, not a sandbox.
const WINDOWS_CONTENTION = new Set(["rename", "unlink", "rmdir", "rm"]);
// What the launcher prints is ACC's own path, never a control record's bytes.
const printable = value => typeof value === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const within = (file, root) => file === root || file.startsWith(`${root}/`) || file.startsWith(`${root}\\`);

const ELSEWHERE = "outside the client's sandbox, or through the client's approved command path for ACC";
export const DENIED_GUIDANCE = Object.freeze({
  write: `Run ACC where its data home is writable: ${ELSEWHERE}`,
  read: `Run ACC where its data home is readable: ${ELSEWHERE}`,
  access: `Run ACC where its data home is readable and writable: ${ELSEWHERE}`,
});

/** Why admission failed, when the filesystem refused it ACC's own state; null
 * otherwise. A refusal outside the runtime directory is a corrupt pointer, not
 * ACC's state. An fchmod on a handle reports no path, so the runtime directory
 * names it, as it does a path ACC would not print. */
export function admissionFailure(error, root = null, platform = process.platform) {
  if (!error || !DENIED.has(error.code)) return null;
  const syscall = typeof error.syscall === "string" ? error.syscall : null;
  if (platform === "win32" && WINDOWS_CONTENTION.has(syscall)) return null;
  const known = typeof root === "string";
  if (typeof error.path === "string" && known && !within(error.path, root)) return null;
  const path = printable(error.path) ? error.path : known && printable(root) ? root : null;
  return { reasonCode: "state_access_denied", access: accessOf(syscall), code: error.code, syscall, path };
}

/** The refused operation and, when the control record was readable, the update state. */
export const deniedGuidance = admission => DENIED_GUIDANCE[admission.access] ?? DENIED_GUIDANCE.access;

export function deniedStateText(admission, control = null) {
  const write = [admission.syscall, admission.path].filter(Boolean).join(" ") || "an operation";
  const update = control?.pending ? `; ACC ${control.pending.version} is pending and needs the same access to finish`
    : control?.phase === "ready" ? "; the runtime is ready and no update is pending" : "";
  return `cannot ${admission.access ?? "access"} ACC's state: ${write} was refused (${admission.code})${update}`;
}
