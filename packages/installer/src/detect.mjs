import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

// Clients print their version in their own shape: "codex-cli 0.147.0", a bare
// "0.36.1", a banner with the number somewhere inside. The number is extracted
// where it can be, and the raw line is kept either way - "present, version
// unreadable" is a real state and hiding it would make the client look absent.
const VERSION = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

/**
 * Ask the operating system what a client reports as its version.
 *
 * Spawning is the only way to know, and it is the only side effect detection
 * has: nothing is written, and a client that is not installed simply fails to
 * start.
 */
export const spawnProbe = async (command, args) => {
  const { stdout, stderr } = await run(command, args);
  return `${stdout}${stderr}`.trim();
};

const withTimeout = (work, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  work.then(resolve, reject).finally(() => clearTimeout(timer));
});

/**
 * Read-only report of what is on this machine.
 *
 * One failing adapter never ends the run. A client whose config is unreadable is
 * exactly the case someone is running this command to find out about, and
 * letting it throw would hide the other three behind it.
 */
export async function detectInstallation({ adapters, context, probe = spawnProbe,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
  const entries = await Promise.all([...adapters]
    // Ordered by id so two runs can be diffed, and so a plan built from this is
    // deterministic rather than dependent on registry order.
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(async adapter => {
      const entry = { adapterId: adapter.id, displayName: adapter.displayName,
        present: false, version: null, versionOutput: null, installed: false,
        diagnostics: [], capabilities: adapter.capabilities ?? {}, error: null };

      try {
        const output = await withTimeout(
          // The declared binary, never the adapter id. Guessing the id made
          // every client whose command differs from it look uninstalled.
          Promise.resolve(probe(adapter.client.command,
            adapter.client.versionArgs ?? ["--version"])),
          probeTimeoutMs, `${adapter.id} version probe`);
        if (typeof output === "string" && output !== "") {
          entry.present = true;
          entry.versionOutput = output;
          entry.version = VERSION.exec(output)?.[1] ?? null;
        }
      } catch (error) {
        entry.error = error.message;
      }

      try {
        const detected = await adapter.detect(context);
        entry.diagnostics = detected.diagnostics ?? [];
        // "Installed" is the adapter's own answer, phrased in its own terms.
        // The installer does not second-guess it by looking at files it does
        // not understand.
        entry.installed = entry.diagnostics.some(line =>
          /registered|installed/.test(line) && !/not registered|not installed/.test(line));
      } catch (error) {
        entry.error = entry.error ?? error.message;
      }
      return entry;
    }));
  return entries;
}
