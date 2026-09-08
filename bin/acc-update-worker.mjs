#!/usr/bin/env node
// Private detached updater. It never opens workspace state or runs a model.
import path from "node:path";
import { runWorker, recordWorkerFailure } from "@agents-can-communicate/cli/managed-worker";
const [root, ...extra] = process.argv.slice(2);
if (typeof root === "string" && path.isAbsolute(root) && extra.length === 0) {
  await runWorker(root, { wait: true }).catch(error => recordWorkerFailure(root, error));
}
