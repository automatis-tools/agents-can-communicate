#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { invokedDirectly, runEntry } from "@agents-can-communicate/cli/managed-entry";

if (invokedDirectly(import.meta.url)) await runEntry({
  kind: "acc-bootstrap", packageRoot: fileURLToPath(new URL("..", import.meta.url)),
});
