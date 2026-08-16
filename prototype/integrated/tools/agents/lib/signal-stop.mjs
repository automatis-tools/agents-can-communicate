export async function withSignalStop(run, signals) {
  let watcher = null;
  let latched = false;
  let stopping = Promise.resolve();
  const stop = () => {
    latched = true;
    if (watcher !== null) stopping = stopping.then(() => watcher.stop());
    return stopping;
  };
  const onSignal = () => { void stop(); };
  signals.once("SIGINT", onSignal);
  signals.once("SIGTERM", onSignal);
  try {
    const code = await run(value => {
      watcher = value;
      if (value !== null && latched) void stop();
    });
    await stopping;
    return code;
  } finally {
    signals.removeListener("SIGINT", onSignal);
    signals.removeListener("SIGTERM", onSignal);
  }
}
