export const writeOutput = (stream, output, { deadlineAt } = {}) => {
  if (output === "") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error === undefined || error === null) resolve();
      else reject(error);
    };
    if (deadlineAt !== undefined) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        finish(new Error("hook budget exhausted before stdout write"));
        return;
      }
      timer = setTimeout(() => finish(
        new Error("hook budget exhausted waiting for stdout callback")), remaining);
    }
    try {
      stream.write(output, finish);
    } catch (error) {
      finish(error);
    }
  });
};

const DIAGNOSTIC_BYTES = 512;

function boundedDiagnostic(label, error) {
  const detail = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/g, " ");
  let line = `acc: ${label}: ${detail}`;
  while (Buffer.byteLength(`${line}\n`, "utf8") > DIAGNOSTIC_BYTES && line.length > 0) {
    line = line.slice(0, -1);
  }
  return `${line}\n`;
}

function tryWrite(stream, output) {
  if (output === "") return;
  try {
    stream.write(output, () => {});
  } catch {
    // A broken diagnostic stream must not turn a failed-open hook into a crash.
  }
}

export async function completeHookOutput(result,
  { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (result.failed || result.timedOut) {
    // Hook failures can include arbitrary payload or filesystem text. Report
    // degradation without reflecting those details into the client's output.
    tryWrite(stderr, "acc: coordination unavailable; hook continued without context\n");
  }
  try {
    await writeOutput(stdout, result.stdout ?? "", { deadlineAt: result.deadlineAt });
  } catch (error) {
    tryWrite(stderr, boundedDiagnostic("stdout write failed", error));
    return { exitCode: 0, wroteStdout: false, committedOffers: false };
  }

  let committedOffers = true;
  try {
    await result.commitOffers?.();
  } catch (error) {
    committedOffers = false;
    tryWrite(stderr, boundedDiagnostic("offer commit failed", error));
  }
  if (result.stderr) tryWrite(stderr, `${result.stderr}\n`);
  return { exitCode: 0, wroteStdout: true, committedOffers };
}
