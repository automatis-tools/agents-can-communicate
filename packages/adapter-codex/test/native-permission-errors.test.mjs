import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import path from "node:path";

import { offerMessage, bindNativeSession, refreshNativeSession } from "../src/native-delivery.mjs";
import { nativeFixture } from "./native-fixture.mjs";
import { posixTransportTest as test } from "../../../tests/helpers/platform-scope.mjs";

// Real filesystem denial before connect, the boundary the old connection-only
// test never exercised. Root bypasses chmod, so that host cannot prove this case.
for (const denied of ["socket metadata", "endpoint record"]) {
  test(`denied ${denied} remains a sender permission failure for offer and refresh`,
    { skip: process.getuid?.() === 0 && "root bypasses filesystem permissions" }, async t => {
      const h = await nativeFixture(t);
      const bound = await bindNativeSession(h);
      const binding = { opaqueEndpointRef: bound.opaqueEndpointRef, clientVersion: bound.clientVersion };
      const directory = denied === "socket metadata" ? path.dirname(h.socketPath)
        : path.join(h.runtimeDir, "codex-native-endpoints");
      const before = h.opened.length;
      await chmod(directory, 0);
      try {
        const offered = await offerMessage({ ...h, binding, message: {} });
        assert.equal(offered.safeErrorCode, "transport_permission_denied");
        const refreshed = await refreshNativeSession({ ...h, binding });
        assert.equal(refreshed.supported, false);
        assert.equal(refreshed.reasonCode, "transport_permission_denied");
        assert.equal(h.opened.length, before, "no transport opened after a denied preflight");
        assert.equal(JSON.stringify([offered, refreshed]).includes(h.root), false);
      } finally {
        await chmod(directory, 0o700);
      }
    });
}

for (const code of ["EPERM", "EACCES"]) {
  test(`${code} during refresh connection remains a sender permission failure`, async t => {
    const h = await nativeFixture(t);
    const bound = await bindNativeSession(h);
    const result = await refreshNativeSession({ ...h,
      binding: { opaqueEndpointRef: bound.opaqueEndpointRef, clientVersion: bound.clientVersion },
      open: () => { throw Object.assign(new Error("private connection details"), { code }); },
    });
    assert.equal(result.reasonCode, "transport_permission_denied");
    assert.equal(JSON.stringify(result).includes("private connection details"), false);
  });
}
