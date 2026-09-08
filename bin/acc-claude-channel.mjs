#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { invokedDirectly, runEntry } from "@agents-can-communicate/cli/managed-entry";
export const resolveSession = async options => (await import("./entrypoints/acc-claude-channel.mjs")).resolveSession(options);
export const ownClient = async options => (await import("./entrypoints/acc-claude-channel.mjs")).ownClient(options);
export const resolveWithin = async options => (await import("./entrypoints/acc-claude-channel.mjs")).resolveWithin(options);

if (invokedDirectly(import.meta.url)) await runEntry({
  kind: "acc-claude-channel", packageRoot: fileURLToPath(new URL("..", import.meta.url)),
});
