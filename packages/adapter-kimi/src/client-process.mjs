import { kimiHomeDir, liveServerInstance } from "./web-registry.mjs";

// The Web server is a packaged binary whose process name differs from the
// `kimi` launcher. Binding still verifies this pid against the registry, so a
// coincidental process name cannot become a delivery endpoint by itself.
export function identifyClientProcess({ comm } = {}) {
  const name = typeof comm === "string" ? comm.split(/[\\/]/).at(-1).replace(/\.exe$/i, "") : "";
  return name === "kimi-code" ? { certificationName: "kimi" } : null;
}

export async function clientVersionOf({ pid, env = process.env } = {}) {
  const instance = await liveServerInstance({ homeDir: kimiHomeDir(env), clientPid: pid });
  return instance?.hostVersion ?? null;
}
