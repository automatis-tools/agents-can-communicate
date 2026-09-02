# Task 10 report — final public v0.2 boundary

## Summary

The CLI and MCP server now expose one communication-first v0.2 contract. `message`,
`request`, `reply`, and `finish` accept caller idempotency keys and generate one key at
their boundary when the caller omits it. Every send-like JSON result has exactly
`{ message, delivery }`; human output begins with durable `recorded message_x` and then
reports any live-offer outcome. Once the durable write succeeds, a router throw remains a
successful command with a safe queued diagnostic.

`message --type` now accepts only `note`, `question`, `request`, `answer`, `decision`, and
`handoff`. The boundary derives the protocol obligation and accepts an explicit
`--obligation` only where the protocol matrix permits it. `--requires-ack`, message
priority/workstream fields, the public intent workstream handle, and `ack --state` are
gone. Public acknowledgement calls `acknowledgeMessage`; it cannot forge a receipt state.
`request` is a typed reply-required message, `reply` is an answer, and `finish` returns its
handoff message through the same send result.

MCP sync no longer doubles as a compatibility mail transport. Addressed content is read
through `acc_inbox`, which advances only the recipient-owned receipt to `retrieved`.
Read-only message resources project the v0.2 attribution, thread, idempotency, kind, and
obligation fields rather than the removed v0.1 message shape.

Gemini CLI exposes next-turn delivery only for exact `0.37.0 / darwin-arm64`; Kimi Code
only for exact `0.36.1 / darwin-arm64`. Other or unparseable versions explicitly
downgrade while retaining durable inbox access. Grok remains polling/inbox only and never
claims next-turn or live-push delivery. Installer detection names the observed downgraded
version and platform without mutating adapter-owned diagnostics. Existing Task 8/9
policy resolution remains authoritative: adapters without a proven user-owned live
binding receive effective `off`, even if the requested policy is retained for reporting.

All five installed ACC skill copies and the one executable example were mechanically
aligned with the v0.2 syntax, receipt state, and attention vocabulary. No migration,
native transport, daemon, proxy, compatibility producer, or core vendor branch was
added.

## Files

- `packages/cli/src/{args,help,main}.mjs`
  - closes the v0.2 arguments, semantic matrix, idempotency boundary, response shape, and
    durable-first human output;
  - removes public orchestration and receipt-state controls;
  - describes requests as reply-required.
- `packages/cli/test/{args,help,integration}.test.mjs`
  - protects exact options, removed legacy controls, help semantics, generated and
    explicit client keys, retries, all send result shapes, truthful receipts, and human
    output ordering.
- `packages/mcp-server/src/{tools,server,resources}.mjs`
  - publishes strict v0.2 schemas and producers;
  - removes sync mail compatibility and public workstream/state controls;
  - projects only the v0.2 message vocabulary.
- `packages/mcp-server/test/{tools,server}.test.mjs`
  - protects schemas, idempotent send results, inbox-only mail, receipt ownership, and
    reply-required request wording.
- `packages/adapter-gemini-cli/{src/adapter.mjs,COMPATIBILITY.md,test/adapter.test.mjs}`
  - documents and tests the exact `0.37.0 / darwin-arm64` next-turn tier and inbox
    downgrade.
- `packages/adapter-kimi/{src/adapter.mjs,COMPATIBILITY.md,test/adapter.test.mjs}`
  - documents and tests the exact `0.36.1 / darwin-arm64` next-turn tier and inbox
    downgrade. The pre-existing test file is over 300 lines and now carries the required
    cohesion justification.
- `packages/adapter-grok/{src/adapter.mjs,COMPATIBILITY.md,test/adapter.test.mjs}`
  - makes polling/inbox fallback explicit and rejects any live-push claim.
- `packages/installer/src/detect.mjs`, `packages/installer/test/detect.test.mjs`
  - name observed version/platform in an uncertified next-turn downgrade and preserve
    durable inbox access.
- Five installed skill copies under `packages/adapter-*/{plugin,extension}/skills/acc/`
  - replace invalid legacy syntax/states and teach `reply_required`,
    `acknowledgement_required`, and `recipient_unavailable`.
- `tests/acceptance/mcp-only.test.mjs`
  - proves the inbox/reply loop at the no-hook tier with `retrieved` and exact send
    results.
- `tests/process/{abandoned-work,session-history,session-resolution,turn-is-actionable}.test.mjs`
  - aligns end-to-end consumers with v0.2 obligations, durable-first output, and attention
    vocabulary. The identity sweep now runs `finish` last because finish correctly closes
    its session.
- `examples/non-git-research.md`
  - mechanically removes the invalid `--requires-ack` executable command.

`packages/installer/src/plan.mjs` and `packages/installer/test/install.test.mjs` needed no
edit: Task 8/9 had already established and tested requested-policy reporting with
effective `off` for every adapter lacking certified `livePush` plus a user-owned binding.

## Strict RED / GREEN

### Primary RED

Before production edits:

```text
node --test packages/cli/test/args.test.mjs packages/cli/test/integration.test.mjs packages/mcp-server/test/tools.test.mjs packages/mcp-server/test/server.test.mjs packages/adapter-gemini-cli/test/adapter.test.mjs packages/adapter-kimi/test/adapter.test.mjs packages/adapter-grok/test/adapter.test.mjs packages/installer/test/detect.test.mjs
```

Observed: **115 tests; 97 pass; 18 fail**. The failures were the intended classes:

1. CLI send boundaries had no `clientMessageId` options, retained `--requires-ack` and
   `ack --state`, passed v0.1 fields to core, and returned flattened/legacy results;
2. MCP schemas lacked client keys, retained legacy message/state fields, called legacy
   producers, and returned flattened/legacy results;
3. remaining adapters did not publish explicit version-aware inbox downgrade diagnostics;
4. installer detection did not name the observed uncertified version and next-turn tier.

After the primary implementation the same command was **115/115 pass**.

### Additional public-surface RED / GREEN

The no-orchestration assertion was added before removing the last public intent handle:

```text
node --test packages/cli/test/args.test.mjs packages/mcp-server/test/tools.test.mjs
```

RED: **25 tests; 23 pass; 2 fail** because CLI `work --workstream` and MCP
`acc_work.workstreamId` were still accepted. GREEN after removal: **25/25 pass**.

Existing process/acceptance tests then exposed the staged v0.1 consumers:

```text
node --test tests/acceptance/mcp-only.test.mjs tests/process/session-history.test.mjs tests/process/abandoned-work.test.mjs
```

RED: **17 tests; 7 pass; 10 fail** on `--requires-ack`, the old flattened MCP request
result, `seen`, old human output, and old attention labels. After aligning those consumers,
the combined run was **17/17 pass**.

Finally, help still described a request as acknowledged even though it creates a reply
obligation:

```text
node --test packages/cli/test/help.test.mjs packages/mcp-server/test/tools.test.mjs
```

RED: **20 tests; 18 pass; 2 fail**. After updating both descriptions: **20/20 pass**.

## Required mutations and restoration

### A. Receipt state override

Mutation:

```text
- ack: { required: ["message"], optional: ["session", "generation"] },
+ ack: { required: ["message"], optional: ["session", "generation", "state"] },
```

Command:

```text
node --test packages/cli/test/args.test.mjs
```

Observed: **15 tests; 14 pass; 1 fail**. `legacy acknowledgement and transport-state
controls are absent` failed with `Missing expected exception` on `ack --state offered`.
The mutation was restored with `apply_patch`; the same command returned **15/15 pass**.

### B. Send result boundary

Mutation flattened the CLI `message` result:

```text
- data: { message, delivery: routed.delivery }
+ data: { ...message, delivery: routed.delivery }
```

Command:

```text
node --test --test-name-pattern="a message reaches a peer" packages/cli/test/integration.test.mjs
```

Observed: **1 test; 0 pass; 1 fail**. The exact shape assertion received every message
field plus `delivery` instead of only `delivery` and `message`. The mutation was restored
with `apply_patch`; the same command returned **1/1 pass**.

## Verification

Final focused communication boundary:

```text
node --test packages/cli/test/args.test.mjs packages/cli/test/help.test.mjs packages/cli/test/integration.test.mjs packages/mcp-server/test/tools.test.mjs packages/mcp-server/test/server.test.mjs packages/adapter-gemini-cli/test/adapter.test.mjs packages/adapter-kimi/test/adapter.test.mjs packages/adapter-grok/test/adapter.test.mjs packages/installer/test/detect.test.mjs tests/acceptance/mcp-only.test.mjs tests/process/session-history.test.mjs tests/process/abandoned-work.test.mjs tests/process/session-resolution.test.mjs tests/process/turn-is-actionable.test.mjs
```

Result: **159 tests; 159 pass; 0 fail**.

The wider Task 10 command covered every CLI, MCP, installer, Gemini, Kimi, Grok,
process, MCP-only acceptance, and package-boundary test and exited **0**. A first
all-parallel run exposed two test-harness issues that were then corrected: reply human
output still expected `replied`, and the identity sweep ran `finish` before `release` even
though finish now closes the session. One writer-lock race also appeared once under the
maximal parallel load and did not recur on the unchanged wider rerun.

Documentation executability:

```text
node --test tests/docs/executable.test.mjs
```

Result: **3 tests; 3 pass; 0 fail**.

Syntax and whitespace:

```text
npm run check
git diff --check
```

Results: **syntax ok in 252 files**; no whitespace errors.

Packed installed artifact, using an isolated npm cache because the machine's default npm
cache is root-owned:

```text
env npm_config_cache=/private/tmp/acc-task10-npm-cache node scripts/verify-package.mjs
```

Result: **PASS**; 166 KB tarball, SHA-256
`23d7eb45436292f2100a42d425dd00e8e60ff046450c6557ff22b4e00b7e6275`, 161 entries,
none forbidden, five exact certification manifests, bundled workspaces, clean install,
doctor, non-Git coordination, and byte-for-byte install/uninstall restoration.

### Full-suite classification

The initial sandboxed full run additionally failed because the sandbox forbade Unix
socket listeners and the default npm cache is root-owned. It also found the one executable
example still using `--requires-ack`; that real Task 10 consumer was fixed and its docs
gate passed.

The full run was repeated outside the filesystem sandbox with the isolated npm cache:

```text
env npm_config_cache=/private/tmp/acc-task10-npm-cache npm test
```

All socket, npm-cache, documentation, CLI, MCP, adapter, installer, process, and package
failures disappeared. Exit remained **1** only for the intentionally stale
`tests/acceptance/recorded-candidate.test.mjs` digest/candidate gate owned by Task 12. Its
exact isolated command reports **1 test; 0 pass; 1 fail**, naming shipped changes since
recorded commit `3ab46be` and instructing the Task 12 re-record. This task did not rewrite
release evidence early.

## Self-review

- Each omitted client key is generated inside exactly one boundary record callback and is
  passed to core once; retry keys supplied by a caller are preserved unchanged.
- All four CLI and MCP send-like operations return only `{ message, delivery }`; explicit
  retry tests prove repeated request/message calls resolve to one logical message.
- `recordAndOffer` records before routing and catches only the post-record router path, so
  transport failure cannot undo or falsify durable success.
- The protocol semantic matrix is reused rather than duplicated as a divergent list;
  addressed handoff defaults to `acknowledge`, room handoff to `none`.
- Public acknowledgement has no receipt state and calls the recipient-owned core
  operation rather than the transport evidence API.
- MCP sync cannot retrieve mail or advance a receipt. `acc_inbox` is the narrow targeted
  read and reports `retrieved`, distinct from acknowledgement.
- Exact adapter certification remains the capability authority. Fallback metadata can
  explain a downgrade but cannot enable next-turn or live delivery.
- Installer planning was not changed merely to satisfy the brief's candidate file list;
  its Task 8/9 tests already prove unsupported adapters resolve effective `off`.
- Core received no Task 10 edit and remains vendor-free. The old internal, now-unreferenced
  `noteNudge` helper and the broader narrative documentation rewrite remain for Task 11;
  no public CLI/MCP producer or installed skill invokes or teaches that compatibility
  syntax.
- Changed production/focused tests are below 300 lines or carry a cohesion header. The
  431-line CLI composition file and 376-line MCP stdio integration test retained their
  existing justifications; the modified 340-line Kimi adapter test now has one.
- `git diff --check`, fresh focused tests, syntax, and the installed tarball were rerun
  after the last behavioral text correction and before the implementation commit.

## Commit

`614227bbc01669328f1fb77111a8ce0aa7fc8a18` —
`feat: expose the v0.2 communication interface`
