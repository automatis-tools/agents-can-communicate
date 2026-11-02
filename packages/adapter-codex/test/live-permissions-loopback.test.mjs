import assert from "node:assert/strict";

import { LOOPBACK_DOMAIN, outgoingStatus, prepareLivePermissions, removeLivePermissions }
  from "../src/live-permissions.mjs";
import { adoptUnmarked } from "../src/unmarked-adoption.mjs";
import { posixTransportTest as test } from "../../../tests/helpers/platform-scope.mjs";

// Kimi Web issue #390. A receiving adapter that declares `inboundLoopback`
// listens on 127.0.0.1; a sandboxed Codex sender reaches it only when ACC's
// profile allows that exact literal under network.domains. Domain rules cannot
// port-restrict, so the literal is the whole grant: no wildcard, no range, and
// external domains stay denied. These tests pin the unit-level behaviour; no
// runtime capture against a real Codex is claimed.

const resolver = existing => target => {
  const resolved = target === "/tmp" || target.startsWith("/tmp/") ? `/private${target}` : target;
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
  receiverSockets: ["/tmp/acc-ch-501", CONTROL] };
const loopback = { ...context, receiverLoopback: true };
const BEFORE = 'model = "mine"\n';
const PROFILE_BODY = `[permissions.acc-workspace]\nextends = ":workspace"\n`
  + `[permissions.acc-workspace.filesystem]\n"/users/test/data/acc" = "write"\n`
  + `[permissions.acc-workspace.network]\nenabled = true\n`
  + `[permissions.acc-workspace.network.unix_sockets]\n`
  + `"/private/tmp/acc-ch-501" = "allow"\n`
  + `"${CONTROL}" = "allow"\n`;
const profileBlock = source =>
  source.match(/# ACC native permissions begin profile\n([\s\S]*?)# ACC native permissions end profile/)[1];
const stripComments = text => text.split("\n").filter(line => !line.trim().startsWith("#")).join("\n");
const adoption = { marketplaceRoot: "/users/test/.agents/acc-local", stateRoot: context.stateRoot,
  sockets: ["/private/tmp/acc-ch-501", CONTROL], controlSocket: CONTROL };

test("a declared loopback receiver adds exactly the 127.0.0.1 literal", () => {
  const prepared = prepareLivePermissions(BEFORE, loopback);
  assert.equal(prepared.status.state, "configured");
  // Byte-exact: the grant is one quoted literal under one domains table, after
  // the socket grants every earlier ACC wrote, and nothing else changes.
  assert.equal(profileBlock(prepared.source), PROFILE_BODY
    + `[permissions.acc-workspace.network.domains]\n"${LOOPBACK_DOMAIN}" = "allow"\n`);
  const domains = prepared.source.match(/^\[permissions\.acc-workspace\.network\.domains\]$/gm) ?? [];
  assert.equal(domains.length, 1);
  // External-domain denial is preserved: the allowlist holds one entry, no
  // wildcard, range or private netblock joins it.
  const granted = [...prepared.source.matchAll(/^(".*") = "allow"$/gm)].map(match => JSON.parse(match[1]));
  assert.deepEqual(granted.filter(item => !item.startsWith("/")), [LOOPBACK_DOMAIN]);
  assert.equal(prepareLivePermissions(prepared.source, loopback).source, prepared.source);
  assert.equal(removeLivePermissions(prepared.source).source, BEFORE);
});

test("without a declaration the profile keeps its byte-for-byte shape", () => {
  const plain = prepareLivePermissions(BEFORE, context).source;
  assert.equal(profileBlock(plain), PROFILE_BODY);
  assert.equal(prepareLivePermissions(BEFORE, { ...context, receiverLoopback: false }).source, plain);
  assert.doesNotMatch(plain, /domains|127\.0\.0\.1/);
  assert.equal(prepareLivePermissions(plain, { ...context, receiverLoopback: false }).source, plain);
});

test("an owned profile from before the declaration is reported and rewritten", () => {
  const old = prepareLivePermissions(BEFORE, context);
  assert.equal(old.status.state, "configured");

  const status = outgoingStatus(old.source, loopback);
  assert.equal(status.state, "unverified");
  assert.equal(status.reasonCode, "sender_permissions_unverified");
  assert.ok(status.diagnostic.includes(LOOPBACK_DOMAIN), status.diagnostic);
  assert.match(status.diagnostic, /run acc install --adapter codex, then start a new session/);
  assert.doesNotMatch(status.diagnostic, /absent|custom permission policy/);

  // The repair runs even under a recorded off, like the missing-socket repair.
  const repaired = prepareLivePermissions(old.source, { ...loopback,
    requestedLivePolicy: "off", livePolicy: "off" });
  assert.equal(repaired.status.state, "configured");
  assert.ok(profileBlock(repaired.source).includes(`"${LOOPBACK_DOMAIN}" = "allow"\n`));
  assert.equal(removeLivePermissions(repaired.source).state, "owned");
  assert.equal(removeLivePermissions(repaired.source).source, BEFORE);
});

test("a grant left after the receiver's live delivery went off is reported and dropped", () => {
  // 127.0.0.1 opens every local port to the sandbox; with no enabled receiver
  // declaring it, the grant is a hole, so a stale profile loses it.
  const granted = prepareLivePermissions(BEFORE, loopback);
  const status = outgoingStatus(granted.source, context);
  assert.equal(status.state, "unverified");
  assert.match(status.diagnostic, /allow 127\.0\.0\.1, which no receiver with live delivery enabled/);
  assert.match(status.diagnostic, /run acc install --adapter codex, then start a new session/);
  const plain = prepareLivePermissions(BEFORE, context).source;
  for (const change of [{}, { requestedLivePolicy: "off", livePolicy: "off" }]) {
    const repaired = prepareLivePermissions(granted.source, { ...context, ...change });
    assert.equal(repaired.status.state, "configured");
    assert.equal(repaired.source, plain);
    assert.doesNotMatch(repaired.source, /domains|127\.0\.0\.1/);
  }
});

test("a custom policy over ACC's profile is preserved, grant or no grant", () => {
  const granted = prepareLivePermissions(BEFORE, loopback).source;
  const edited = granted.replace(`"${LOOPBACK_DOMAIN}" = "allow"\n`,
    `"${LOOPBACK_DOMAIN}" = "allow"\n"internal.example.com" = "allow"\n`);
  assert.notEqual(edited, granted);
  for (const change of [{}, { requestedLivePolicy: "off", livePolicy: "off" }]) {
    const prepared = prepareLivePermissions(edited, { ...loopback, ...change });
    assert.equal(prepared.source, edited);
    assert.equal(prepared.status.reasonCode, "permission_configuration_modified");
  }
});

test("an unmarked profile with the loopback grant is adopted and re-marked", () => {
  const unmarked = stripComments(prepareLivePermissions(BEFORE, loopback).source);
  const adopted = adoptUnmarked(unmarked, adoption);
  assert.ok(adopted.adopted > 0, "nothing was adopted");
  assert.doesNotMatch(adopted.source, /permissions\.acc-workspace/);
  const reinstalled = prepareLivePermissions(adopted.source, loopback);
  assert.equal(reinstalled.status.state, "configured");
  assert.ok(profileBlock(reinstalled.source).includes(`"${LOOPBACK_DOMAIN}" = "allow"\n`));
});

test("an unmarked profile without a domains table is still ACC's own", () => {
  const unmarked = stripComments(prepareLivePermissions(BEFORE, context).source);
  const adopted = adoptUnmarked(unmarked, adoption);
  assert.ok(adopted.adopted > 0, "nothing was adopted");
  assert.doesNotMatch(adopted.source, /permissions\.acc-workspace/);
});

test("an unmarked profile allowing another domain stays the user's policy", () => {
  const unmarked = stripComments(prepareLivePermissions(BEFORE, loopback).source)
    .replace(`"${LOOPBACK_DOMAIN}" = "allow"\n`, `"${LOOPBACK_DOMAIN}" = "allow"\n"example.com" = "allow"\n`);
  const adopted = adoptUnmarked(unmarked, adoption);
  assert.equal(adopted.adopted, 0);
  assert.equal(adopted.source, unmarked);
  // What adoption leaves is custom policy: it is never rewritten for the grant.
  const prepared = prepareLivePermissions(adopted.source, loopback);
  assert.equal(prepared.status.reasonCode, "permission_configuration_modified");
});
