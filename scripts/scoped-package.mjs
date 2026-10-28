// Reuse the runner's one packed artifact and the push command's owned teardown.
import { lstat, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPushCommand } from "./push-targets.mjs";
import { testFileTimeout } from "./test-runner-plan.mjs";
import { removeFixture } from "../tests/helpers/fixture-cleanup.mjs";

export async function verifyScopedPackage({ repo, template }) {
  let temporary;
  let retain = false;
  const controller = new AbortController();
  const interrupt = () => { retain = true; controller.abort(); };
  let timer;
  try {
    const pack = path.join(template, "pack");
    const archives = (await readdir(pack)).filter(name => name.endsWith(".tgz"));
    if (archives.length !== 1) throw Error("scoped package requires exactly one regular archive");
    const archive = path.resolve(pack, archives[0]);
    if (!(await lstat(archive)).isFile()) throw Error("scoped package requires exactly one regular archive");
    temporary = await mkdtemp(path.join(tmpdir(), "acc-docs-smoke-"));
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    timer = setTimeout(interrupt, testFileTimeout());
    await runPushCommand(process.execPath, [path.join(repo, "scripts/verify-package.mjs"), archive], {
      cwd: repo, signal: controller.signal,
      env: { ACC_NO_UPDATE_CHECK: "1", TMPDIR: temporary, TMP: temporary, TEMP: temporary },
    });
    if (controller.signal.aborted) throw Error("documentation package smoke interrupted or deadline exceeded; resources retained");
  } catch (error) {
    if (error.code === "PUSH_TERMINATION_UNCONFIRMED" || controller.signal.aborted) retain = true;
    if (retain) throw Object.assign(Error("documentation package smoke interrupted or termination unconfirmed; resources retained", { cause: error }),
      { code: "SCOPED_PACKAGE_RETAINED" });
    if (error.code === "ENOENT") throw Error("scoped package archive unavailable", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (!retain) {
      try { if (temporary) await removeFixture(temporary); }
      finally { await removeFixture(template); }
    }
  }
}
