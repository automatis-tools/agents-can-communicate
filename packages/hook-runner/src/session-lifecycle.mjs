import { createHash } from "node:crypto";
import path from "node:path";

import { withWriterMutex } from "@agents-can-communicate/storage-filesystem";

// Binding ownership spans load, resume/open/close, and publication. The store's
// writer lock protects each record, but cannot protect this whole hook sequence.
// Use the same crash-safe mutex in a separate directory to avoid nested locks.
export function withSessionLifecycle({ root, sessionId, clock, deadlineAt }, operation) {
  const key = createHash("sha256").update(String(sessionId)).digest("hex");
  return withWriterMutex({ locks: path.join(root, "lifecycle-locks", key) },
    { root, clock, deadlineAt }, operation);
}
