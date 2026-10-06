// A node:test reporter that writes one JSON line per file event and per
// top-level test, stamped with the runner's own clock. The file's dequeue and
// its summary bound the file's wall time in the parent, process start and
// module loading included.
export default async function* fileTimingReporter(source) {
  for await (const event of source) {
    const data = event.data ?? {};
    const at = performance.timeOrigin + performance.now();
    if (event.type === "test:dequeue" || event.type === "test:enqueue") {
      if (data.nesting === 0) yield `${JSON.stringify({ type: event.type, file: data.file ?? null, name: data.name, at })}\n`;
    } else if (event.type === "test:summary") {
      yield `${JSON.stringify({ type: event.type, file: data.file ?? null, ms: data.duration_ms,
        counts: data.counts, success: data.success, at })}\n`;
    } else if ((event.type === "test:pass" || event.type === "test:fail") && data.nesting === 0) {
      yield `${JSON.stringify({ type: event.type, file: data.file ?? null, name: data.name,
        ms: data.details?.duration_ms ?? 0, skip: data.skip !== undefined && data.skip !== false, at })}\n`;
    }
  }
}
