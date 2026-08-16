# ACC Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the verified core and adapters into an installable, documented, secure npm product with reversible setup and release evidence.

**Architecture:** One top-level CLI detects harnesses and installs owned adapter entries. Runtime state stays under platform user-data directories; optional project config carries only stable policy. Release automation publishes pinned workspace packages and verifies installation in clean environments.

**Tech Stack:** npm workspaces, Node.js current LTS selected at execution time from official release data, GitHub Actions pinned to exact current stable revisions, Markdown documentation.

**Spec:** `docs/superpowers/specs/2026-08-15-standalone-acc-design.md` §§5, 9–11 plus `docs/UX.md` and `docs/SECURITY.md`.

## Global Constraints

- Precondition: cross-vendor adapter acceptance is green.
- Verify package and binary name availability before modifying manifests.
- Verify every dependency and Action from its primary source and pin the latest stable version current on the execution date.
- Do not publish or create a public release without explicit user approval.
- Installer changes must be previewable, idempotent, and reversible.
- No secrets, runtime bus files, transcripts, or user-specific absolute paths enter Git or npm tarballs.

---

### Task 1: Finalize package identity and runtime locations

**Files:**
- Modify: `package.json`
- Modify: `packages/*/package.json`
- Create: `packages/cli/src/platform-paths.mjs`
- Create: `packages/cli/test/platform-paths.test.mjs`
- Create: `.npmignore` — superseded by `files` in the manifests, which is an
  allowlist rather than a denylist; see the completion note

**Interfaces:**
- Produces final npm scope/name, `acc` binary mapping, Node engine floor, and platform data/config/cache paths

- [x] **Step 1: Check publication namespaces**

Query npm registry for `agents-can-communicate`, the selected organization scope, and `acc` binary collisions. Record results in the PR description. If the unscoped package is unavailable, use the approved organization scope without changing the binary name unless that binary also conflicts.

This step also resolves two open decisions from `docs/DECISIONS.md` with the user before any manifest changes: the public license (open decision 3) and the publication model — one publishable CLI package that bundles the workspaces versus scoped per-package publication (part of open decision 2). `npx agents-can-communicate install` from `docs/UX.md` requires the entry package to be publishable, so the root manifest cannot stay `private: true` unless a dedicated entry package replaces it. Record both answers in `docs/DECISIONS.md` as user-approved.

- [x] **Step 2: Verify current Node LTS**

Use <https://nodejs.org/en/about/previous-releases>. Pin the current production LTS major in `engines.node`; do not select a Current-only release.

- [x] **Step 3: Write platform-path RED**

Test macOS, Linux/XDG, and Windows environment fixtures. Assert config, data, and cache paths are outside a Workspace and portable IDs remain filename-safe.

- [x] **Step 4: Implement and run GREEN**

Implement injected environment/platform resolution. Run:

```bash
node --test packages/cli/test/platform-paths.test.mjs
```

- [x] **Step 5: Inspect npm tarball and commit**

```bash
npm pack --dry-run
git add package.json packages .npmignore
git commit -m "build: finalize ACC package identity"
```

Expected tarball excludes `prototype/`, `migration/`, `.agents/`, build evidence, IDE files, and user paths.

---

### Task 2: Implement optional project configuration

**Files:**
- Create: `packages/protocol/src/config.mjs`
- Create: `packages/protocol/test/config.test.mjs`
- Create: `packages/cli/src/config-command.mjs`
- Create: `packages/cli/test/config-command.test.mjs`
- Create: `docs/CONFIGURATION.md`

**Interfaces:**
- Produces `acc config init`, `acc config validate`, and schema-versioned project config

- [x] **Step 1: Write config RED**

Test no-config defaults, stable Workspace ID, multi-root declarations, claim policy, context budget, required adapters, unknown version rejection, runtime-key rejection, and symlink escape.

- [x] **Step 2: Define minimal config schema**

```json
{
  "schema_version": 1,
  "workspace_id": "workspace_example",
  "display_name": "Example",
  "roots": ["."],
  "policy": {
    "claim_mode": "advisory",
    "context_budget_bytes": 6000
  },
  "required_adapters": []
}
```

Reject messages, sessions, claims, tokens, transcripts, and absolute runtime paths in project config.

- [x] **Step 3: Implement commands and docs**

`config init` writes only after preview/confirmation in human mode and requires explicit `--yes` in non-interactive mode. `validate` is read-only.

- [x] **Step 4: Mutation proof and commit**

Temporarily allow `sessions` in config; the runtime-key test must fail. Restore.

```bash
git add packages docs/CONFIGURATION.md
git commit -m "feat: add optional workspace configuration"
```

---

### Task 3: Build unified installer and doctor

**Files:**
- Create: `packages/installer/package.json`
- Create: `packages/installer/src/detect.mjs`
- Create: `packages/installer/src/plan.mjs`
- Create: `packages/installer/src/apply.mjs`
- Create: `packages/installer/src/ownership.mjs`
- Create: `packages/installer/test/detect.test.mjs`
- Create: `packages/installer/test/install.test.mjs`
- Create: `packages/installer/test/recovery.test.mjs`
- Modify: `packages/cli/src/main.mjs`

**Interfaces:**
- Produces `acc install`, `acc install --dry-run`, `acc uninstall`, and unified `acc doctor`

- [x] **Step 1: Write installation-plan RED**

Fixtures contain zero, one, and all supported clients plus existing unrelated configs. Dry-run returns exact planned paths and semantic changes without touching bytes.

- [x] **Step 2: Write crash/idempotence RED**

Inject failure between two adapter writes. Re-run install and assert it completes safely without duplicate entries. Uninstall removes only operations whose ownership record matches current installed bytes.

- [x] **Step 3: Implement detect/plan/apply split**

Detection is read-only. Plan is deterministic JSON. Apply uses no-replace or compare-and-swap semantics per config format and records ownership outside project repositories.

- [x] **Step 4: Integrate doctor**

Doctor reports client binary/version, adapter installed version, hook registration, actual capabilities, runtime health, pending migrations, and exact remediation command.

- [x] **Step 5: Verify and commit**

```bash
node --test packages/installer/test/*.test.mjs
npm test
git add packages/installer packages/cli
git commit -m "feat: install and diagnose ACC adapters"
```

---

### Task 4: Complete public documentation and examples

**Files:**
- Rewrite: `README.md`
- Create: `docs/GETTING_STARTED.md`
- Create: `docs/CLI.md`
- Create: `docs/MCP.md`
- Create: `docs/ADAPTER_AUTHORING.md`
- Create: `docs/TROUBLESHOOTING.md`
- Create: `examples/papercut-workstreams.md`
- Create: `examples/non-git-research.md`
- Create: `tests/docs/commands.test.mjs`

**Interfaces:**
- Produces complete user and adapter-author onboarding

- [x] **Step 1: Write documentation command RED**

Extract fenced commands marked `<!-- test:command -->` and run them against a temporary installation. The initial test fails because public docs do not yet contain the required flows.

- [x] **Step 2: Write three-minute getting started**

Cover install, ordinary session opening, automatic attach, status, conflict, message, and uninstall. Separate automatic native behavior from MCP fallback behavior.

- [x] **Step 3: Document adapter authoring**

Include manifest schema, capability rules, hook normalization, config ownership, conformance runner, delivery semantics, and one minimal Tier-1 MCP adapter.

- [x] **Step 4: Add concise examples**

Papercut example uses visual, models, and physics workstreams with global claims. Non-Git example coordinates research and document review without Git concepts.

- [x] **Step 5: Run docs test and commit**

```bash
node --test tests/docs/commands.test.mjs
git add README.md docs examples tests/docs
git commit -m "docs: explain cross-model collaboration"
```

---

### Task 5: Complete threat model and security gates

**Files:**
- Expand: `docs/SECURITY.md`
- Create: `docs/THREAT_MODEL.md`
- Create: `SECURITY.md`
- Create: `tests/security/peer-injection.test.mjs`
- Create: `tests/security/storage-boundary.test.mjs`
- Create: `tests/security/installer.test.mjs`

**Interfaces:**
- Produces public vulnerability-reporting policy and release-blocking security suite

- [x] **Step 1: Write threat scenarios**

For each actor and asset, record preconditions, attack, consequence, prevention, detection, and residual risk. Include malicious peer, stale process, symlink escape, replay, claim denial, installer takeover, MCP tool poisoning, and corrupt store.

- [x] **Step 2: Write RED security tests**

Demonstrate attributed peer content cannot become policy, storage cannot escape its managed root, and installer ownership cannot delete unrelated config.

- [x] **Step 3: Implement only evidence-backed fixes**

Run focused tests after each minimal change. Do not broaden permissions or add transcript filtering heuristics unrelated to the failing fixture.

- [x] **Step 4: Full security verification and commit**

```bash
node --test tests/security/*.test.mjs
npm test
git add docs/SECURITY.md docs/THREAT_MODEL.md SECURITY.md tests/security packages
git commit -m "security: define ACC trust boundaries"
```

---

### Task 6: Add CI and prepare an unpublished release candidate

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `CHANGELOG.md`
- Create: `docs/RELEASING.md`
- Create: `scripts/verify-package.mjs`

**Interfaces:**
- Produces reproducible CI and local release-candidate verification; does not publish without approval

- [x] **Step 1: Verify and pin Actions**

Check official repositories for the latest stable checkout and setup-node Actions. Pin exact immutable commit SHAs and annotate human versions in YAML comments.

- [x] **Step 2: Define CI matrix**

Run supported Node LTS on macOS, Linux, and Windows. Gates: clean install, syntax, unit/process/conformance/docs/security tests, package-boundary scan, line-count policy, `npm pack`, and tarball inspection.

- [x] **Step 3: Write package verifier**

`scripts/verify-package.mjs` packs every publishable workspace, rewrites inter-package dependency specifiers to the freshly packed local tarballs (before first publication they cannot resolve from the public registry), installs the entry tarball into a clean temp directory, runs `acc --json doctor`, exercises a non-Git Workspace, and proves uninstall cleanup.

- [x] **Step 4: Prove CI gate liveness locally**

Temporarily include `prototype/` in the npm tarball. `verify-package.mjs` must fail on forbidden content. Restore exclusions and rerun green.

- [x] **Step 5: Build release candidate without publishing**

```bash
npm ci
npm test
npm run check
npm pack
node scripts/verify-package.mjs *.tgz
git diff --check
```

Record tarball name, digest, test counts, client capability matrix, and known limitations in `CHANGELOG.md`.

- [x] **Step 6: Commit**

```bash
git add .github CHANGELOG.md docs/RELEASING.md scripts/verify-package.mjs
git commit -m "ci: prepare ACC release candidate"
```

Stop before npm publication, Git tag, GitHub release, or remote install test. Request explicit user approval for those external mutations.


## Completion note (2026-08-16)

All six tasks are delivered. Three deviations, each deliberate:

**One package, not eight.** The user approved a single publishable
`agents-can-communicate` carrying its workspaces. That removes Task 3's
requirement to rewrite inter-package dependency specifiers to locally packed
tarballs - there is nothing to rewrite. `bundleDependencies` does the work, and
`scripts/verify-package.mjs` proves the result installs and runs with no
workspace anywhere.

**`files` instead of `.npmignore`.** An allowlist rather than a denylist. Having
both means reading two files to answer one question.

**camelCase config, not the plan's snake_case example.** Every protocol record is
camelCase and workspace discovery already read `schemaVersion`; following the
illustration literally would have cost a second convention for one hand-edited
file.

Nothing was published. No npm release, no tag, no GitHub release - those need
explicit approval and are described in `docs/RELEASING.md`.
