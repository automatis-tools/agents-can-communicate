import { realpath } from "node:fs/promises";
import path from "node:path";
import { askConfirmation } from "../confirm.mjs";
import { ALL_ADAPTERS } from "../install-command.mjs";
import { MAINTENANCE_ACTIVE, readMaintenance } from "./maintenance-state.mjs";

const inspectServices = async options => (await import("./maintenance.mjs")).inspectMaintenanceServices(options);
const request = async options => (await import("./maintenance.mjs")).requestMaintenance(options);
const handoff = () => Object.assign(new Error("ACC maintenance needs confirmation or recovery; run acc update."),
  { code: "ACC_LEGACY_MAINTENANCE_HANDOFF" });

async function isLegacyWorker(argv, control, root) {
  if (argv.length !== 3) return false;
  try {
    return await realpath(argv[1]) === await realpath(path.join(control.active.root, "bin", "acc-update-worker.mjs"))
      && await realpath(argv[2]) === await realpath(root);
  } catch { return false; }
}

/** Old activation imports this candidate before taking its admission fence.
 * Only request/schedule here: the detached job waits for this process to exit.
 * Throwing in the old background worker unwinds its idle-loop lock normally.
 */
export async function bridgeLegacyMaintenance({ control, root, env = process.env, callerProtocol = 1 }, {
  argv = process.argv, input = process.stdin, output = process.stdout,
  inspect = inspectServices, requestMaintenance = request,
} = {}) {
  if (callerProtocol >= 2) return null;
  const worker = await isLegacyWorker(argv, control, root);
  const interactive = argv[2] === "update" && !argv.includes("--json")
    && input.isTTY === true && output.isTTY === true;
  if (!worker && !interactive) return null;
  const existing = await readMaintenance(root);
  let services;
  if (!MAINTENANCE_ACTIVE.includes(existing?.status)) {
    if (!control.pending) return null;
    services = await inspect({ root, control, env, adapters: ALL_ADAPTERS() });
    if (!services.length) return null;
    if (worker) throw handoff();
  }
  const result = await requestMaintenance({ root, control, options: { json: false }, services,
    runtime: { env, input, output, confirm: askConfirmation,
      isInteractive: () => interactive, packageRoot: control.pending?.root ?? control.active.root } });
  if (worker) throw handoff();
  if (result?.text) output.write(`${result.text}\n`);
  return result;
}
