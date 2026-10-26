// Codes with which the filesystem refuses a process the writes admission needs:
// a client sandbox or host policy around ACC's data home, or files another user
// owns (#316). ChatGPT Work Mode refused an fchmod; a Codex chat without ACC's
// rules file refused the lock's mkdir. Both were then told an update was
// unfinished, while the runtime was ready and nothing was pending.
const DENIED = new Set(["EPERM", "EACCES", "EROFS"]);

export const DENIED_GUIDANCE = "Run ACC where its data home is writable: outside the client's sandbox, "
  + "or through the client's approved command path for ACC";

/** Why admission failed, when the reason is a denied write; null otherwise. An
 * fchmod on a handle reports no path, so the runtime directory names it. */
export function admissionFailure(error, root = null) {
  if (!error || !DENIED.has(error.code)) return null;
  return { reasonCode: "state_access_denied", code: error.code,
    syscall: typeof error.syscall === "string" ? error.syscall : null,
    path: typeof error.path === "string" ? error.path : typeof root === "string" ? root : null };
}

/** The refused write and, when the control record was readable, the update state. */
export function deniedStateText(admission, control = null) {
  const write = [admission.syscall, admission.path].filter(Boolean).join(" ") || "a write";
  const update = control?.pending ? `; ACC ${control.pending.version} is pending and needs the same access to finish`
    : control?.phase === "ready" ? "; the runtime is ready and no update is pending" : "";
  return `cannot write ACC's state: ${write} was refused (${admission.code})${update}`;
}
