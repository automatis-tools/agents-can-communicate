import path from "node:path";
import { channelSocketDirectory, tomlString } from "@agents-can-communicate/adapter-sdk";
import { compareStableVersions, parseStableVersion } from "./app-server-client.mjs";
import { addPermissions, inspectPermissions } from "./permission-ownership.mjs";
import { scanConfig } from "./toml-scan.mjs";

const PROFILE = "acc-workspace";
const MINIMUM = "0.153.4";
const equal = (keys, expected) => JSON.stringify(keys) === JSON.stringify(expected);
const literal = value => { try { return JSON.parse(value); } catch { return null; } };
const supported = context => context.platform === "darwin-arm64"
  && parseStableVersion(context.clientVersion) !== null
  && compareStableVersions(context.clientVersion, MINIMUM) >= 0;
const hasPermissions = entries => entries.some(entry =>
  ["permissions", "default_permissions", "profile", "profiles"].includes(entry.keys[0]));
const configured = (source, context) => {
  const entries = scanConfig(source);
  if (entries.some(entry => ["profile", "profiles"].includes(entry.keys[0]))) return false;
  const value = keys => entries.find(entry => !entry.header && equal(entry.keys, keys))?.value;
  const profile = literal(value(["default_permissions"]));
  if (!profile || value(["sandbox_mode"]) || entries.some(entry => entry.keys[0] === "sandbox_workspace_write")) return false;
  return literal(value(["permissions", profile, "extends"])) === ":workspace"
    && value(["features", "network_proxy"]) === "true"
    && value(["permissions", profile, "network", "enabled"]) === "true"
    && literal(value(["permissions", profile, "filesystem", context.stateRoot])) === "write"
    && sockets(context).every(socket => literal(value(["permissions", profile, "network", "unix_sockets", socket])) === "allow");
};

// Match the channel's per-user temporary directory and Codex's actual home.
// Grants cover only ACC's local channel namespace, never arbitrary Unix sockets.
const sockets = context => [channelSocketDirectory(),
  path.join(context.codexHome ?? path.join(context.home, ".codex"), "app-server-control", "app-server-control.sock")];

export function outgoingStatus(source, context) {
  const state = inspectPermissions(source).state;
  const ready = state === "owned" && supported(context) && configured(source, context);
  const reasonCode = state === "customized" ? "permission_configuration_modified"
    : !supported(context) ? "permission_configuration_uncaptured"
      : ready ? null : "sender_permissions_unverified";
  return { state: reasonCode === null ? "configured" : "unverified", reasonCode,
    setup: supported(context)
      ? "Codex outgoing setup: default workspace settings gain ACC state write access and an ACC local socket allowlist "
        + "through the network proxy (external network stays denied); custom policies are preserved. Start a new session after installation."
      : null,
    diagnostic: reasonCode === null
      ? "outgoing live delivery: local socket permissions configured for new sessions; active session overrides remain unverified"
      : `outgoing live delivery: sender permissions unverified in ${context.file}; `
        + (reasonCode === "permission_configuration_uncaptured"
          ? `automatic setup requires Codex ${MINIMUM} or newer on darwin-arm64`
          : "existing permissions were preserved; run acc install --adapter codex, then start a new session; "
            + "custom permission policies must allow ACC state and local sockets through the network proxy") };
}

export function prepareLivePermissions(source, context) {
  const owned = inspectPermissions(source);
  const requested = (context.requestedLivePolicy ?? context.livePolicy ?? "off") !== "off";
  if (owned.state === "customized") return { source, skipLegacy: true, status: outgoingStatus(source, context) };
  if (!requested) return { source: owned.source, skipLegacy: hasPermissions(scanConfig(owned.source)) };
  if (!supported(context) || !context.stateRoot) {
    return { source, skipLegacy: hasPermissions(scanConfig(source)), status: outgoingStatus(source, context) };
  }
  if (owned.state === "owned" && configured(source, context)) {
    return { source, skipLegacy: true, status: outgoingStatus(source, context) };
  }
  source = owned.source;
  const entries = scanConfig(source);
  const find = keys => entries.filter(entry => equal(entry.keys, keys));
  const modes = find(["sandbox_mode"]), defaults = find(["default_permissions"]);
  const legacy = entries.filter(entry => entry.keys[0] === "sandbox_workspace_write");
  const features = entries.filter(entry => entry.keys[0] === "features");
  const featureTable = find(["features"]);
  const proxies = find(["features", "network_proxy"]);
  const customized = entries.some(entry => ["permissions", "profile", "profiles"].includes(entry.keys[0]))
    || modes.length > 1 || defaults.length > 1
    || modes.some(entry => entry.header || literal(entry.value) !== "workspace-write")
    || defaults.some(entry => entry.header || literal(entry.value) !== ":workspace")
    || (legacy.length > 0 && (legacy.length !== 2 || !legacy[0].header || legacy[0].array
      || !equal(legacy[1].keys, ["sandbox_workspace_write", "writable_roots"])
      || JSON.stringify(literal(legacy[1].value)) !== JSON.stringify([context.stateRoot])))
    || (features.length > 0 && (featureTable.length !== 1 || !featureTable[0].header || featureTable[0].array))
    || proxies.length > 1 || proxies.some(entry => entry.header || !["true", "false"].includes(entry.value));
  if (customized) return { source, skipLegacy: hasPermissions(entries), status: outgoingStatus(source, context) };
  const edits = [{ id: "selection", start: 0, end: 0, body: `default_permissions = "${PROFILE}"\n` }];
  for (const [id, values] of [["mode", modes], ["default", defaults]]) {
    if (values.length) edits.push({ id, start: values[0].start, end: values[0].end, body: "" });
  }
  if (legacy.length) {
    const end = entries.find(entry => entry.header && entry.start > legacy[0].start)?.start ?? source.length;
    edits.push({ id: "legacy", start: legacy[0].start, end, body: "" });
  }
  const proxy = proxies[0], table = featureTable[0];
  edits.push({ id: "proxy", start: proxy?.start ?? table?.end ?? source.length,
    end: proxy?.end ?? table?.end ?? source.length, table: table ? ["features"] : null,
    body: `${table ? "" : "[features]\n"}network_proxy = true\n` });
  // Preserve a final line without a newline through the same ownership unit.
  const last = entries.at(-1);
  if (last && !source.endsWith("\n") && !edits.some(edit => edit.start <= last.start && edit.end >= last.end)) {
    edits.push({ id: "tail", start: last.start, end: last.end, body: `${last.raw}\n` });
  }
  edits.push({ id: "profile", start: source.length, end: source.length, body:
    `[permissions.${PROFILE}]\nextends = ":workspace"\n`
    + `[permissions.${PROFILE}.filesystem]\n${tomlString(context.stateRoot)} = "write"\n`
    + `[permissions.${PROFILE}.network]\nenabled = true\n`
    + `[permissions.${PROFILE}.network.unix_sockets]\n`
    + sockets(context).map(socket => `${tomlString(socket)} = "allow"\n`).join("") });
  const prepared = addPermissions(source, edits);
  return { source: prepared, skipLegacy: true, status: outgoingStatus(prepared, context) };
}

export const removeLivePermissions = source => inspectPermissions(source);
