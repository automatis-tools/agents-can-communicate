import assert from "node:assert/strict";
import test from "node:test";

import { withServer } from "./stdio-harness.mjs";

const claim = args => ["acc_claim", { action: "acquire", ...args }];
const release = args => ["acc_release", args];

test("MCP rejects invalid claim selectors before opening a session", async t => {
  const cases = [
    [...claim({ resources: [] }), /at least|nonempty/],
    [...claim({ resources: "file:src/a.mjs" }), /must be an array/],
    [...claim({ resources: [null] }), /resources\[0\].*string/],
    [...claim({ resources: [""] }), /resources\[0\].*at least|nonempty/],
    [...claim({ resources: ["file:a.mjs", "file:a.mjs"] }), /duplicate|unique/],
    [...claim({ resources: ["file:./a.mjs", "file:a.mjs"] }), /duplicate|unique/],
    [...claim({ resources: ["file:src/*.mjs"] }), /matches nothing/],
    [...claim({ resources: ["not-a-uri"] }), /resource URI/],
    [...claim({ resource: "" }), /at least|nonempty/],
    [...claim({ resource: "file:a.mjs", resources: ["file:b.mjs"] }), /arguments/],
    [...claim({ resources: ["file:a.mjs"], claimId: "claim_x" }), /arguments/],
    ["acc_claim", { action: "renew", claimId: "claim_x", resources: ["file:a.mjs"] }, /arguments/],
    ["acc_claim", { action: "renew", claimIds: ["claim_x"] }, /claimIds/],
    ["acc_claim", { action: "renew", claimId: "" }, /at least|nonempty/],
    [...release({}), /arguments/],
    [...release({ claimIds: [] }), /at least|nonempty/],
    [...release({ resources: [] }), /at least|nonempty/],
    [...release({ claimIds: "claim_x" }), /must be an array/],
    [...release({ resources: "file:a.mjs" }), /must be an array/],
    [...release({ claimIds: [false] }), /claimIds\[0\].*string/],
    [...release({ resources: [0] }), /resources\[0\].*string/],
    [...release({ claimIds: [""] }), /claimIds\[0\].*at least|nonempty/],
    [...release({ resources: [""] }), /resources\[0\].*at least|nonempty/],
    [...release({ claimIds: ["claim_x", "claim_x"] }), /duplicate|unique/],
    [...release({ claimIds: ["claim invalid"] }), /portable identifier/],
    [...release({ claimId: "" }), /at least|nonempty/],
    [...release({ resources: ["file:a.mjs", "file:a.mjs"] }), /duplicate|unique/],
    [...release({ resources: ["file:./a.mjs", "file:a.mjs"] }), /duplicate|unique/],
    [...release({ resources: ["file:src/*"] }), /matches nothing/],
    [...release({ resource: "not-a-uri" }), /resource URI/],
    [...release({ all: false }), /arguments/],
    [...release({ all: "true" }), /arguments/],
    [...release({ all: true, authority: "human" }), /authority/],
  ];
  const selectors = [{ claimId: "claim_x" }, { claimIds: ["claim_x"] },
    { resource: "file:a.mjs" }, { resources: ["file:a.mjs"] }, { all: true }];
  for (let left = 0; left < selectors.length; left += 1) {
    for (let right = left + 1; right < selectors.length; right += 1) {
      cases.push([...release({ ...selectors[left], ...selectors[right] }), /arguments/]);
    }
  }
  for (const [name, args, diagnostic] of cases) {
    await t.test(`${name} ${JSON.stringify(args)}`, async caseTest => {
      await withServer(caseTest, async ({ request, meta }) => {
        const response = await request("tools/call", { name, arguments: args, _meta: meta });
        assert.equal(response.result.isError, true);
        assert.match(response.result.content[0].text, diagnostic);
        const roster = await request("resources/read", { uri: "acc://roster", _meta: meta });
        assert.deepEqual(JSON.parse(roster.result.contents[0].text), []);
      });
    });
  }
});
