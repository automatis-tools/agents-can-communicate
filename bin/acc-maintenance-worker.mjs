#!/usr/bin/env node
import { runMaintenance } from "../node_modules/@agents-can-communicate/cli/src/managed-runtime/maintenance-worker.mjs";

// This private entry has no workspace admission/lease and no inherited stdio.
// Durable checkpoints remain available to the next acc update after a crash.
await runMaintenance(process.argv[2], { jobId: process.argv[3] }).catch(() => { process.exitCode = 1; });
