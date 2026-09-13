import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { failMaintenance, runMaintenanceCommand } from "./maintenance-host.mjs";

// Pinned official installer: its noninteractive mode retains other installations.
// Keep the script and its behavior review separate from the selected CLI version.
export const CODEX_INSTALLER = Object.freeze({
  url: "https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/scripts/install/install.sh",
  sha256: "ba92dd27e5c06f0d3bbc58bfa4b9cfb6599cd2742fbb1f92a2765e6c07dedb5a",
});

export async function installCodexStandalone(plan, { env, beforeInstall,
  download, run = runMaintenanceCommand, source = CODEX_INSTALLER } = {}) {
  let directory;
  try {
    if (typeof download !== "function") failMaintenance("prerequisite_download_unavailable");
    const script = await download(source);
    directory = await mkdtemp(path.join(os.tmpdir(), "acc-codex-installer-"));
    const file = path.join(directory, "install.sh");
    await writeFile(file, script, { mode: 0o600, flag: "wx" });
    await beforeInstall();
    const bin = path.join(plan.codexHome, "packages/standalone/bin");
    const result = await run("/bin/sh", [file, "--release", plan.cliVersion], {
      cwd: plan.home, timeout: 300_000,
      env: { ...env, HOME: plan.home, CODEX_HOME: plan.codexHome,
        CODEX_RELEASE: plan.cliVersion, CODEX_NON_INTERACTIVE: "1",
        CODEX_INSTALLER_USE_RELEASES_OPENAI_COM: "true", CODEX_INSTALL_DIR: bin,
        // The official installer skips profile edits when its bin is on PATH.
        // This PATH belongs only to the installer; the user's command is retained.
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    });
    if (result.status !== 0) failMaintenance("prerequisite_install_failed");
  } catch (error) {
    if (error.reasonCode) throw error;
    failMaintenance("prerequisite_install_failed");
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
