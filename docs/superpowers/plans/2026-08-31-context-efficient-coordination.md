# Context-efficient coordination implementation plan

**Goal:** Make compaction safe, keep automatic ACC context small, and give agents
targeted message operations that do not require a workspace dump.

**Architecture:** Reuse the generation-bearing hook binding to resume a session;
project only actionable coordination plus a compact peer trigger; implement
addressed-message reads and reply-plus-ack in core and expose them through CLI
and MCP. Rewrite the bundled skill around selective communication.

**Spec:** `docs/superpowers/specs/2026-08-31-context-efficient-coordination-design.md`

## Constraints

- Node 24 ESM and built-ins only; no runtime dependencies.
- No vendor branching in `packages/core`.
- Production modules and focused tests stay under 300 lines unless cohesion is
  explicitly documented.
- Tests exercise behavior through real stores and installed artifacts rather
  than source-text assertions where a behavioral surface exists.
- Prove each new gate by reverting or mutating the exact protected behavior and
  observing the new test fail.

## Tasks

### 1. Idempotent SessionStart

- Add a focused hook-runner regression that starts the same harness session
  twice and expects one durable session and one identity.
- Add a core operation that refreshes an exact open session generation without
  creating a second `session.opened` event.
- Make SessionStart resume a valid binding and fall back to open for invalid or
  closed bindings.
- Run the focused test, then mutate the resume branch back to unconditional
  open and prove the test fails.

### 2. Compact automatic projection

- Add focused projector tests for duplicate peer rows, many unrelated claims,
  an addressed message, and an over-budget message.
- Group peers by participant, omit ambient roster and claim details, and keep a
  concise skill trigger under 200 bytes.
- Preserve actionable message bodies and relevant conflict information.
- Name a dropped message id and recommend `acc inbox --message <id>` on
  overflow; never recommend full sync.
- Run projector and turn-actionability tests and mutate the claim/roster
  filtering to prove the size gate catches regression.

### 3. Targeted inbox and reply

- Add core tests covering queued and previously injected direct requests,
  recipient isolation, seen transitions, reply addressing, `inReplyTo`, and
  acknowledgement.
- Implement `inbox` and reply-to-message services with one durable transaction
  for reply plus acknowledgement.
- Expose `acc inbox [--message]` and
  `acc reply --message --body` through argument parsing, help, CLI, and MCP.
- Add process tests against a real file store and update surface-coverage gates.
- Mutate recipient validation and acknowledgement independently and prove the
  tests fail.

### 4. Rewrite guidance and documentation

- Shorten the installed ACC skill; make hook context an explicit trigger and
  teach silence-by-default, targeted reads, and concise messages.
- Update README, CLI docs, concepts, architecture, adapter compatibility, and
  changelog as required by the shipped behavior.
- Replace tests that require full sync for routine recovery with tests for the
  narrow protocol.
- Package the project and inspect the actual bundled skill rather than only the
  source copy.

### 5. Repair the unrelated Claude hook

- Change `cleanup-git-allow.sh` so absent optional files return success and the
  script has an explicit successful exit.
- Re-run it from a directory with no project `.claude` settings; verify exit 0,
  no stderr, and no unintended global-settings change.

### 6. Final verification

- Run `npm run check`, `npm test`, and
  `npm pack && node scripts/verify-package.mjs`.
- Install the tarball into an isolated temporary home and run the real CLI
  inbox/reply path plus adapter installation/package verification.
- Review `git diff --check`, file sizes, and worktree status. Do not push or
  merge.
