import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";

// Instrument only the pause point. The installed executable, record writes,
// filesystem locks and journal recovery all run normally. The parent then kills
// its own fixture process, rather than simulating a successful write in memory.
export async function crashHook(packed, { boundary, payload, participantId = "crash-writer" }) {
  const bootstrap = path.join(packed.root, `crash-${boundary}.mjs`);
  await writeFile(bootstrap, `
    import { registerHooks } from "node:module";
    import { pathToFileURL } from "node:url";
    globalThis.accCrashCheckpoint = async details => {
      process.send({ boundary: ${JSON.stringify(boundary)}, details });
      await new Promise(() => setInterval(() => {}, 1000));
    };
    registerHooks({ load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const targets = {
        "after-open": ["/hook-runner/src/runner.mjs",
          "    const hookBinding = { accSessionId: session.sessionId",
          "    await globalThis.accCrashCheckpoint(session);\\n"],
        "before-open": ["/hook-runner/src/runner.mjs",
          "    const session = await context.service.openSession({",
          "    await globalThis.accCrashCheckpoint(null);\\n"],
        "before-binding-publish": ["/adapter-sdk/src/session-binding.mjs",
          "  await rename(temporary, file);",
          "  if (record.platform !== undefined) await globalThis.accCrashCheckpoint(record);\\n"],
        "after-close": ["/hook-runner/src/runner.mjs",
          "    await clearSessionBinding({ runtimeDir: paths.root, harnessSessionId: event.sessionId });",
          "    await globalThis.accCrashCheckpoint(null);\\n"],
      };
      const [suffix, needle, pause] = targets[${JSON.stringify(boundary)}];
      if (!url.endsWith(suffix)) return result;
      const source = Buffer.from(result.source).toString();
      if (source.split(needle).length !== 2) throw Error("crash boundary must match once");
      return { ...result, source: source.replace(needle, pause + needle) };
    } });
    process.argv = [process.execPath, ${JSON.stringify(packed.hookBin)}, "claude_code"];
    await import(pathToFileURL(process.argv[1]));
  `);
  const child = fork(bootstrap, [], { cwd: packed.project,
    env: { ...packed.env, ACC_PARTICIPANT: participantId },
    stdio: ["pipe", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.resume();
  const exited = once(child, "exit");
  let timer;
  try {
    child.stdin.end(JSON.stringify(payload));
    const [checkpoint] = await Promise.race([
      once(child, "message"),
      exited.then(result => { throw new Error(`hook exited before checkpoint: ${result}: ${stderr}`); }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("hook did not reach crash checkpoint")), 15_000);
      }),
    ]);
    child.kill("SIGKILL");
    const [, signal] = await exited;
    if (signal !== "SIGKILL") throw new Error(`fixture was not killed: ${signal}`);
    return checkpoint;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}
