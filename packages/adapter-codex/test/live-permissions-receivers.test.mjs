import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import nodeTest from "node:test";

import { createCodexAdapter } from "../src/adapter.mjs";
import { grantPath, outgoingStatus, prepareLivePermissions, removeLivePermissions }
  from "../src/live-permissions.mjs";
import { posixTransportTest as test } from "../../../tests/helpers/platform-scope.mjs";

// Issue #213. The profile allowed ACC's channel directory and the Codex control
// socket; Claude Code receives in `/tmp/cc-socks`, so every `acc reply` from a
// Codex sandbox to Claude Code failed with EPERM and waited for the next turn,
// while doctor reported the permissions configured.

// Bytes ACC 0.8.1's own module wrote for `model = "mine"\n` on macOS, uid 501:
// the adapter source was unchanged from v0.8.1 at 259fdc3, which generated it.
const WRITTEN_BY_081 = readFileSync(new URL("./fixtures/acc-0.8.1-outgoing-profile.toml",
  import.meta.url), "utf8");
const BEFORE = 'model = "mine"\n';

// macOS: `/tmp` is a link to `/private/tmp`, and realpath(3) returns the
// resolved path of what exists, so a fake keeps these tests host-independent.
const resolver = (existing, links = {}) => target => {
  const resolved = links[target] ?? (target === "/tmp" || target.startsWith("/tmp/")
    ? `/private${target}` : target);
  if (!existing.includes(resolved)) throw Object.assign(new Error(target), { code: "ENOENT" });
  return resolved;
};
const darwin = resolver(["/", "/private", "/private/tmp", "/users", "/users/test",
  "/users/test/.codex"]);
const CONTROL = "/users/test/.codex/app-server-control/app-server-control.sock";
const context = { home: "/users/test", codexHome: "/users/test/.codex",
  stateRoot: "/users/test/data/acc", file: "/users/test/.codex/config.toml",
  requestedLivePolicy: "actionable", livePolicy: "off", clientVersion: "0.157.1",
  platform: "darwin-arm64", realpath: darwin,
  receiverSockets: ["/tmp/acc-ch-501", "/tmp/cc-socks", "/tmp/cc-socks-501", CONTROL] };
const grants = source => [...source.matchAll(/^(".*") = "allow"$/gm)].map(match => JSON.parse(match[1]));

test("the Codex control socket is declared for sandboxed senders", () => {
  const adapter = createCodexAdapter();
  assert.deepEqual(adapter.inboundSockets({ home: "/h", codexHome: "/c" }),
    [path.join("/c", "app-server-control", "app-server-control.sock")]);
  assert.deepEqual(adapter.inboundSockets({ home: "/h" }),
    [path.join("/h", ".codex", "app-server-control", "app-server-control.sock")]);
});

// Measured with `codex sandbox -P` on 0.157.1: a grant missing when Codex builds
// the policy is kept as written and `/tmp/x` then never matches; `/private/tmp/x`
// matches either way. A link keeps its own name: its target changes per daemon.
test("grants are spelled as the kernel resolves them, keeping the last component", () => {
  assert.equal(grantPath("/tmp/cc-socks-501", darwin), "/private/tmp/cc-socks-501");
  assert.equal(grantPath("/tmp/a/b/c", darwin), "/private/tmp/a/b/c");
  assert.equal(grantPath(CONTROL, resolver(["/", "/users", "/users/test", "/users/test/.codex",
    "/users/test/.codex/app-server-control", "/private/tmp/codex-daemon-501/abc"],
  { [CONTROL]: "/private/tmp/codex-daemon-501/abc" })), CONTROL);
  const linux = resolver(["/", "/run", "/run/user", "/run/user/1000", "/tmp"]);
  assert.equal(grantPath("/run/user/1000/cc-socks", linux), "/run/user/1000/cc-socks");
  assert.equal(grantPath("/tmp/cc-socks", linux), "/tmp/cc-socks");
  assert.equal(grantPath("/x/y", () => { throw new Error("nothing resolves"); }), "/x/y");
});

test("the profile allows every socket ACC delivers to", () => {
  const prepared = prepareLivePermissions(BEFORE, context);
  assert.equal(prepared.status.state, "configured");
  assert.deepEqual(grants(prepared.source).sort(), [CONTROL, "/private/tmp/acc-ch-501",
    "/private/tmp/cc-socks", "/private/tmp/cc-socks-501"].sort());
  assert.equal(prepareLivePermissions(prepared.source, context).source, prepared.source);
  assert.equal(removeLivePermissions(prepared.source).source, BEFORE);
});

test("the profile is configured only while it covers every receiver", () => {
  const partial = prepareLivePermissions(BEFORE, { ...context,
    receiverSockets: context.receiverSockets.filter(item => !item.includes("cc-socks")) }).source;
  const status = outgoingStatus(partial, context);
  assert.equal(status.state, "unverified");
  assert.equal(status.reasonCode, "sender_permissions_unverified");
});

test("a profile ACC 0.8.1 wrote reads as incomplete and names the fix", () => {
  assert.equal(removeLivePermissions(WRITTEN_BY_081).state, "owned");
  const status = outgoingStatus(WRITTEN_BY_081, context);
  assert.equal(status.state, "unverified");
  assert.equal(status.reasonCode, "sender_permissions_unverified");
  for (const missing of ["/private/tmp/cc-socks", "/private/tmp/cc-socks-501"]) {
    assert.ok(status.diagnostic.includes(missing), status.diagnostic);
  }
  assert.match(status.diagnostic, /run acc install --adapter codex, then start a new session/);
  assert.doesNotMatch(status.diagnostic, /absent|custom permission policy/);
});

test("reinstalling over a 0.8.1 profile rewrites ACC's own unit", () => {
  for (const change of [{}, { requestedLivePolicy: "off", livePolicy: "off" }]) {
    const prepared = prepareLivePermissions(WRITTEN_BY_081, { ...context, ...change });
    assert.equal(prepared.status.state, "configured", JSON.stringify(change));
    assert.ok(grants(prepared.source).includes("/private/tmp/cc-socks"));
    assert.equal(removeLivePermissions(prepared.source).state, "owned");
    assert.equal(removeLivePermissions(prepared.source).source, BEFORE);
  }
});

test("a fresh off install still adds no grants", () => {
  const prepared = prepareLivePermissions(BEFORE, { ...context,
    requestedLivePolicy: "off", livePolicy: "off" });
  assert.equal(prepared.source, BEFORE);
});

test("a 0.8.1 profile the user edited stays theirs", () => {
  const edited = WRITTEN_BY_081.replace('"/tmp/acc-ch-501" = "allow"\n',
    '"/tmp/acc-ch-501" = "allow"\n"/Users/me/own.sock" = "allow"\n');
  assert.notEqual(edited, WRITTEN_BY_081);
  for (const change of [{}, { requestedLivePolicy: "off", livePolicy: "off" }]) {
    const prepared = prepareLivePermissions(edited, { ...context, ...change });
    assert.equal(prepared.source, edited);
    assert.equal(prepared.status.reasonCode, "permission_configuration_modified");
  }
});

// A setting the user added beside ACC's unit is theirs to reconcile: with
// incoming delivery off, nothing is rewritten and nothing is taken away.
test("off leaves an outdated profile beside a user's own sandbox setting as it is", () => {
  const withMode = `sandbox_mode = "read-only"\n${WRITTEN_BY_081}`;
  assert.equal(removeLivePermissions(withMode).state, "owned");
  const prepared = prepareLivePermissions(withMode, { ...context,
    requestedLivePolicy: "off", livePolicy: "off" });
  assert.equal(prepared.source, withMode);
  assert.equal(prepared.status.state, "unverified");
});

// The consent question and the install preview show this text. The allowlist
// now reaches other clients' session inboxes, and the person approving it is told.
test("the setup disclosure names every kind of socket the profile allows", () => {
  const { setup } = outgoingStatus(BEFORE, context);
  assert.match(setup, /ACC's own channel, the Codex control socket and other clients' session inboxes/);
  assert.match(setup, /external network stays denied/);
});
