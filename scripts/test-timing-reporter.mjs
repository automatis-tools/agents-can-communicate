import path from "node:path";
import { realpath } from "node:fs/promises";
import { testFileTimeout } from "./test-runner-plan.mjs";

// A file's complete event includes process startup and final handle cleanup,
// unlike a sum of nested test durations. Stream records so completed files
// remain visible even if another file exceeds its deadline.
export default async function* timings(events) {
  const active = new Map();
  const timeoutMs = testFileTimeout();
  try {
    for await (const { type, data } of events) {
      if (!data.file || !data.name || path.resolve(data.name) !== path.resolve(data.file)) continue;
      const file = await realpath(data.file).catch(() => path.resolve(data.file));
      if (type === "test:dequeue") {
        let entry = active.get(file);
        if (!entry) {
          const timer = setTimeout(() => {
            if (process.send) process.send({ type: "acc-test-file-deadline", file, timeoutMs });
            else {
              console.error(`test file ${file} exceeded ${timeoutMs} ms`);
              process.exit(1);
            }
          }, timeoutMs).unref();
          entry = { started: performance.now(), timer, pending: 0 };
          active.set(file, entry);
        }
        entry.pending += 1;
      } else if (type === "test:complete") {
        const entry = active.get(file);
        // A user test may itself be named after its file. Match dequeue and
        // complete counts so that cannot clear the outer file's deadline.
        if (entry && --entry.pending === 0) {
          clearTimeout(entry.timer);
          active.delete(file);
          yield JSON.stringify({ file, durationMs: performance.now() - entry.started,
            success: data.details.passed }) + "\n";
        }
      }
    }
  } finally {
    for (const entry of active.values()) clearTimeout(entry.timer);
  }
}
