import { createRequire } from "node:module";

import { MCP_CAPABILITIES } from "./tools.mjs";

export const PROTOCOL_VERSION = "2026-07-28";
export const INITIALIZED_VERSIONS = Object.freeze(["2025-11-25", "2025-06-18"]);
export const SUPPORTED_VERSIONS = Object.freeze([PROTOCOL_VERSION, ...INITIALIZED_VERSIONS]);
const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version;
const SERVER_INFO = Object.freeze({ name: "agents-can-communicate", version: PACKAGE_VERSION });
const CAPABILITIES = Object.freeze({ tools: {}, resources: {} });
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const rpcError = (rpcCode, message, rpcData) =>
  Object.assign(new Error(message), { rpcCode, rpcData });

const complete = result => ({ resultType: "complete",
  _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO }, ...result });

function requireProtocolMeta(params) {
  const meta = params?._meta ?? {};
  const version = meta[VERSION_KEY];
  if (typeof version !== "string" || !isObject(meta[CAPABILITIES_KEY])) {
    throw rpcError(-32602,
      "each request requires _meta protocolVersion and clientCapabilities");
  }
  if (version !== PROTOCOL_VERSION) {
    throw rpcError(-32022, `unsupported protocol version: ${version}`,
      { supported: [...SUPPORTED_VERSIONS], requested: version });
  }
}

/**
 * Dual-era stdio: 2025 clients initialize their transport; 2026 requests carry
 * their own metadata. Only protocol readiness is connection-local. ACC identity
 * and durable session continuity always come from the server's launch config.
 */
export function createProtocol() {
  let phase = "uninitialized";
  return {
    notify(message) {
      if (message.method === "notifications/initialized" && phase === "initializing") {
        phase = "ready";
      }
    },
    async request({ method, params }, execute) {
      if (method === "initialize") {
        if (phase !== "uninitialized") throw rpcError(-32600, "already initialized");
        if (typeof params?.protocolVersion !== "string" || !isObject(params.capabilities)
          || !isObject(params.clientInfo) || typeof params.clientInfo.name !== "string"
          || typeof params.clientInfo.version !== "string") {
          throw rpcError(-32602, "initialize requires protocolVersion, capabilities and clientInfo");
        }
        const protocolVersion = INITIALIZED_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion : INITIALIZED_VERSIONS[0];
        phase = "initializing";
        return { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO };
      }

      const meta = params?._meta;
      const modern = method === "server/discover"
        || (isObject(meta) && (Object.hasOwn(meta, VERSION_KEY)
          || Object.hasOwn(meta, CAPABILITIES_KEY)));
      if (modern) {
        // Never inherit even one missing metadata field from an initialize.
        requireProtocolMeta(params);
      } else if (method !== "ping" && phase !== "ready") {
        if (phase === "initializing") throw rpcError(-32600, "client has not sent initialized");
        requireProtocolMeta(params);
      }
      const result = method === "server/discover"
        ? { supportedVersions: [...SUPPORTED_VERSIONS], capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO, accCapabilities: MCP_CAPABILITIES }
        : method === "ping" ? {} : await execute();
      if (modern) return complete(result);
      // 2025 structuredContent only accepts objects. Preserve the original
      // JSON in text content for array/scalar tools such as acc_inbox.
      if (Object.hasOwn(result, "structuredContent") && !isObject(result.structuredContent)) {
        const { structuredContent, ...legacy } = result;
        return legacy;
      }
      return result;
    },
  };
}
