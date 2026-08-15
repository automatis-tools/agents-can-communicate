import { readFile } from "node:fs/promises";

export async function protocolCompatibilityIssue(context) {
  try {
    const value = JSON.parse(await readFile(context.paths.protocol, "utf8"));
    if (value?.schema_version !== 1) return { code: "UNKNOWN_SCHEMA_VERSION",
      severity: "error", path: context.paths.protocol, message: "unknown schema version" };
    if (value?.protocol_version !== 1) return { code: "UNKNOWN_PROTOCOL_VERSION",
      severity: "error", path: context.paths.protocol, message: "unknown protocol version" };
  } catch {}
  return null;
}
