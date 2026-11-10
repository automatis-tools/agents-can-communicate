import { existsSync } from "node:fs";
import path from "node:path";

const CLIENTS = ["agy", "claude", "codex", "gemini", "grok", "kimi"];
const holdsClient = dir => CLIENTS.some(client =>
  [client, `${client}.cmd`, `${client}.exe`].some(name => existsSync(path.join(dir, name))));

/**
 * A PATH for a test that runs `acc install` in a throwaway home.
 *
 * Live delivery is on by default, so an install that detects a real Codex starts
 * that client's service, and the service outlives the test and writes into the
 * home it is removing. CI has no clients; this makes a developer machine match.
 */
export function pathWithoutClients(env = process.env) {
  const kept = (env.PATH ?? "").split(path.delimiter).filter(dir => dir !== "" && !holdsClient(dir));
  return [path.dirname(process.execPath), ...kept].join(path.delimiter);
}
