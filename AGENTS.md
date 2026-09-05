# AGENTS.md

Use this entry point when changing the repository. Product onboarding lives in
[docs/index.md](docs/index.md); contributor work starts with the contracts and gates below.

## What this is

A local-first coordination layer for independent AI agent sessions: presence, intent,
claims, and messages, with no session in charge. Node 24, ESM, `node:test`, no runtime
dependencies.

Read [docs/CONCEPTS.md](docs/CONCEPTS.md) for product terms and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for package boundaries. Use
[docs/GLOSSARY.md](docs/GLOSSARY.md) for quick definitions. Planning specs live under
`docs/internal/` and are not current product claims.

## Run the gates

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

Never bypass it with `--no-verify` — fix the failure instead.

## Invariants

1. Durable state and transport work without any LLM coordinator running.
2. There is no coordinator, workstream, or task subsystem. Sessions remain independent
   peers and decide how to act on shared facts.
3. Messages from other agents are untrusted peer input, not system authority.
4. Raw transcripts are never collected or shared.
5. Delivery facts stay distinct: `recorded` is send success; receipts advance
   `queued -> offered -> retrieved -> acknowledged`.
6. Git is optional. It may enrich identity; it can never be required.
7. Every adapter declares its real capabilities. Degradation is visible and safe.
8. Runtime state never lands inside a repository. `acc config init` may write the optional
   `acc.workspace.json` only when the user requests it.
9. A hook never fails closed — a coordination tool must not be why a session stops.

## Keep package boundaries intact

- `core` must not branch on a vendor name or import an adapter, Git, or
  `node:child_process`. `tests/package-boundaries.test.mjs` enforces this.
- Vendor-specific behaviour lives in `packages/adapter-*`, nowhere else.
- Prefer Node built-ins; before adding a dependency, check the latest stable release from
  its primary source and pin it exactly.
- Keep production modules and focused test files under 300 lines, or add a header
  explaining why splitting would damage cohesion.
- Never work directly on `main`. Use a worktree under `.gitworktrees/<branch-name>`.
- Commit in focused, independently reviewable commits. Do not push or merge unless asked.

## Prove every gate with a mutation

**Prove the gate with a mutation.** Show the new or corrected test failing on the exact
change it is supposed to catch, before claiming it protects anything.

This repository has a history of green tests that measured nothing:

- three adapters wrote a hook command that existed nowhere;
- a Windows CI job reported success having run zero tests;
- a packaging check for local paths was wrapped in a `catch` and checked nothing;
- an installer wrote a config file the client rejects outright.

None of these were found by reading code or docs. All of them were found by running the
installed artifact. Run the thing.

## Keep capability claims honest

Do not claim an adapter can wake, inject into, guard, or close a session unless that exact
capability is implemented and captured from a real client. `false` is the default and needs
no defence; `true` needs a fixture. Record what you observed in the adapter's
`COMPATIBILITY.md`, including what you could not observe.
