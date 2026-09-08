#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { invokedDirectly, runEntry } from "@agents-can-communicate/cli/managed-entry";
export { writeOutput, completeHookOutput } from "./entrypoints/hook-output.mjs";

if (invokedDirectly(import.meta.url)) await runEntry({
  kind: "acc-hook", packageRoot: fileURLToPath(new URL("..", import.meta.url)),
});
