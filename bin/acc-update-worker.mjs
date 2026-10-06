#!/usr/bin/env node
// Private detached updater. It never runs a model; the only workspace state it
// opens is an older store it migrates to this generation's contract.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorker, recordWorkerFailure } from "@agents-can-communicate/cli/managed-worker";
const [root, ...extra] = process.argv.slice(2);
// The generation this worker belongs to, so it reclaims only as the active one.
const generationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (typeof root === "string" && path.isAbsolute(root) && extra.length === 0) {
  await runWorker(root, { wait: true, generationRoot }).catch(error => recordWorkerFailure(root, error));
}
