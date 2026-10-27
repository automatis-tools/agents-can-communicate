# AGENTS.md

Use this entry point when changing the repository. Product onboarding lives in
[docs/index.md](docs/index.md); contributor work starts with the contracts and gates below.

## What this is

A local-first coordination layer for independent AI agent sessions: presence, intent,
claims, and messages, with no session in charge. Node 24, ESM, `node:test`, no runtime
dependencies.

Read [docs/CONCEPTS.md](docs/CONCEPTS.md) for product terms and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for package boundaries. Use
[docs/GLOSSARY.md](docs/GLOSSARY.md) for quick definitions. Dated planning/reference material under
`docs/internal/` and `docs/superpowers/` is not current product documentation. Published
release-evidence records retain their original source, artifact, and capture provenance.

## Run the gates

```bash
npm ci
npm run check      # syntax-check every tracked .mjs
npm test           # the whole suite; refuses to pass on an empty file list

# Pack once outside the checkout, then verify that exact archive.
set -o pipefail
acc_package="$(mktemp -d "${TMPDIR:-/tmp}/acc-package.XXXXXX")"
npm pack --pack-destination "$acc_package" &&
  node scripts/verify-package.mjs "$acc_package"/*.tgz 2>&1 |
  tee "$acc_package/verification.log"
```

Keep `$acc_package` with the validation evidence. It contains the archive and the verification log, including its SHA-256 digest.

On macOS outside CI, `npm test` skips fsync and runs more test files at once: each flush there
is a 4 ms F_FULLFSYNC. `ACC_TEST_REAL_FSYNC=1 npm test` keeps every flush; CI always does.

Plain `npm test` always executes the complete suite. A successful local run records a disposable
full receipt outside the checkout. Pre-push can select documentation tests for an ordinary branch
only when every change since its exact pushed base is an audited documentation change.
Each ref keeps its own plan before identical trees join. Full requirements take precedence over
documentation requirements, then measurement-only requirements. For ordinary refs, main, release,
code changes, new branches without a usable base, and uncertain plans require the full suite.

To create and inspect a standalone plan for the latest commit, use:

```bash
acc_plan="$(mktemp -t acc-docs-plan.XXXXXX)"
node scripts/change-plan.mjs --base "$(git rev-parse HEAD^)" \
  --target "$(git rev-parse HEAD)" --event push \
  --ref "$(git symbolic-ref HEAD)" --output "$acc_plan"
npm test -- --selection-plan "$acc_plan" --list
npm test -- --selection-plan "$acc_plan"
npm test -- --selection-plan "$acc_plan" --if-needed
rm "$acc_plan"
```

For multiple commits, replace `HEAD^` with the exact pushed base commit. Keep the plan outside
the checkout. The runner validates its immutable Git facts, complete test discovery and actual
checkout bytes. Missing, invalid, stale or unsupported plans restore full discovery. Selection
cannot combine with shards. Listing never runs tests, packs, verifies packages or records proof.

Every uncached documentation run executes the complete selected documentation profile and verifies the
exact single archive already created by its packed template. This smoke never repacks.
The output identifies documentation, full, cached and shard results separately. Documentation
success records only a documentation receipt. It never proves full-suite success. Full success
cannot satisfy a documentation receipt request either. Keep the explicit package gate above
for shipped documentation and final artifact qualification.

Pre-push runs attribution first and syntax-checks the actual target. It passes selection arguments
only when the target's test script and scoped runner contract match the trusted implementation,
including imported selection, cache, process and package helpers. Historical or changed contracts
run their own full suite. Ignored executable inputs or dirty target bytes require an isolated checkout.

Pre-push adds `--if-needed` only for a supported clean current checkout. The same scope can reuse
its receipt for 24 hours when file bytes, installed workspace links, Node and environment match.
Changed inputs, failed reruns, uncertain dependencies or unavailable cache state require execution.
Actual reruns invalidate both receipts first. If an existing exact-key proof cannot be removed or
its absence cannot be established, validation stops before execution with a fixed diagnostic.
Syntax checks likewise reuse only successful parses of identical files with the same Node/options.
Commit-message and pushed-history checks always run.

CI executes its existing full gates and never reuses local suite receipts. This local optimization
does not change GitHub routing. Windows runs `npm test -- --shard 1/2` and `2/2`. Their union is
the whole discovered list, and the existing Windows check requires both to pass.
`--list` can inspect a shard without packing. Test files have a ten-minute process deadline
(`ACC_TEST_FILE_TIMEOUT_MS`) in addition to the five-minute default per-test deadline
(`ACC_TEST_TIMEOUT_MS`), so leaked handles cannot silently hold a gate forever. The runner
prints the slowest files; `ACC_TEST_TIMINGS` saves file timings as JSONL to the specified path.

Enable the commit-msg and pre-push gates once per clone:

```bash
git config core.hooksPath .githooks
```

Never bypass them with `--no-verify` — fix the failure instead.

Commit messages and pull request descriptions carry no Claude attribution: no
`Co-Authored-By: Claude` or `<noreply@anthropic.com>` trailer, no `Claude-Session:` line,
no "Generated with Claude Code" footer. The commit-msg gate refuses such a message, the
pre-push gate refuses a push that carries one, and the required Lint job checks the whole
history and the pull request description with `scripts/check-commit-attribution.mjs`.

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
