import path from "node:path";

// One line when a test file starts and one when it ends. The spec reporter
// prints a file's results only when the file ends, so a job that hits its time
// limit otherwise shows nothing about the files still running (#408). CI turns
// this on with ACC_TEST_PROGRESS=1; ci-validation reads these lines to name the
// running files when it stops a test command at its deadline.
export const PROGRESS_PREFIX = "acc-test-file";

const shown = file => {
  const relative = path.relative(process.cwd(), file);
  return (relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file)
    .split(path.sep).join("/");
};

export default async function* progress(events) {
  // Matched dequeue and complete counts, as in the timing reporter: a test may
  // itself be named after its file.
  const active = new Map();
  for await (const { type, data } of events) {
    if (!data?.file || !data.name || path.resolve(data.name) !== path.resolve(data.file)) continue;
    const file = path.resolve(data.file);
    if (type === "test:dequeue") {
      const entry = active.get(file) ?? { started: performance.now(), pending: 0 };
      if (entry.pending++ === 0) {
        active.set(file, entry);
        yield `${PROGRESS_PREFIX} start ${shown(file)}\n`;
      }
    } else if (type === "test:complete") {
      const entry = active.get(file);
      if (entry && --entry.pending === 0) {
        active.delete(file);
        const seconds = ((performance.now() - entry.started) / 1000).toFixed(1);
        yield `${PROGRESS_PREFIX} done ${shown(file)} ${seconds} s ${data.details?.passed ? "passed" : "failed"}\n`;
      }
    }
  }
}

// Follows the lines above in streamed output: which files started and have not
// finished. Chunks may split a line anywhere.
export function progressTracker() {
  const running = new Set();
  let partial = "";
  return {
    feed(chunk) {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) {
        // A path may contain spaces: a start line ends with it, and a done
        // line ends with its fixed duration and result after it.
        const start = /^acc-test-file start (.+)$/.exec(line);
        const done = /^acc-test-file done (.+) \d+\.\d s (?:passed|failed)$/.exec(line);
        if (start) running.add(start[1]);
        else if (done) running.delete(done[1]);
      }
    },
    running: () => [...running],
  };
}
