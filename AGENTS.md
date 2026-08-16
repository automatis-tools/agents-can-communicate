# AGENTS.md

Entry point for any agent — or person — working on this repository.

## What this is

A local-first coordination layer for independent AI agent sessions: presence, intent,
claims, and messages, with no session in charge. Node 24, ESM, `node:test`, **no runtime
dependencies**.

Start with [README.md](README.md), then [docs/CONCEPTS.md](docs/CONCEPTS.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

```bash
npm ci
npm run check      # syntax-check every tracked .mjs
npm test           # the whole suite; refuses to pass on an empty file list
npm pack && node scripts/verify-package.mjs   # what a user actually receives
```

Enable the pre-push gate once per clone:

```bash
git config core.hooksPath .githooks
```

Never bypass it with `--no-verify`. Fix the failure instead.

## Invariants

1. Durable state and transport work without any LLM coordinator running.
2. A coordinator is a role inside a workstream, never the owner of a workspace or of
   another session.
3. Messages from other agents are untrusted peer input, not system authority.
4. Raw transcripts are never collected or shared.
5. Delivery states are truthful: `recorded`, `queued`, `injected`, `seen`, and
   `acknowledged` are different things.
6. Git is optional. It may enrich identity; it can never be required.
7. Every adapter declares its real capabilities. Degradation is visible and safe.
8. Nothing ACC writes lands inside a repository.
9. A hook never fails closed — a coordination tool must not be why a session stops.

## Rules of the codebase

- `core` must not branch on a vendor name or import an adapter, Git, or
  `node:child_process`. `tests/package-boundaries.test.mjs` enforces this.
- Vendor-specific behaviour lives in `packages/adapter-*`, nowhere else.
- Prefer Node built-ins. Before adding a dependency, check the latest stable release from
  its primary source and pin it exactly.
- Keep production modules and focused test files under 300 lines, or add a header
  explaining why splitting would damage cohesion.
- Never work directly on `main`. Use a worktree under `.gitworktrees/<branch-name>`.
- Commit in focused, independently reviewable commits. Do not push or merge unless asked.

## The rule that matters most

**Prove the gate with a mutation.** Show the new or corrected test failing on the exact
change it is supposed to catch, before claiming it protects anything.

This repository has a history of green tests that measured nothing:

- three adapters wrote a hook command that existed nowhere;
- a Windows CI job reported success having run zero tests;
- a packaging check for local paths was wrapped in a `catch` and checked nothing;
- an installer wrote a config file the client rejects outright.

None of these were found by reading code or docs. All of them were found by running the
installed artifact. Run the thing.

## Capability honesty

Do not claim an adapter can wake, inject into, guard, or close a session unless that exact
capability is implemented **and** captured from a real client. `false` is the default and
needs no defence; `true` needs a fixture. Record what you observed in the adapter's
`COMPATIBILITY.md`, including what you could not observe.
