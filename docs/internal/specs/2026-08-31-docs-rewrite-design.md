# ACC Documentation Rewrite — Design Spec

**Date:** 2026-08-31
**Status:** Design. Execution deferred (see §8). No `docs/`, `packages/`, or `tests/` rewrite happens until this spec is approved and the coordinating conditions in §8 are met.

---

## 1. Goal

Recreate the entire ACC documentation set from scratch, at the clarity and
craft of the case-study/onboarding artifacts, in English. A clean
information architecture with a single spine, an opinionated on-ramp, a
neutral and trustworthy reference, and no redundancy. Not bound to the
current structure.

Success = a first-time reader lands, follows one obvious path, and never
reads the same concept explained three different ways; a reference user
finds the exact command/field fast; the test suite stays green.

## 2. Decisions locked (from brainstorming)

1. **Approach B** — greenfield information architecture, free file renaming,
   and update the doc tests to match (preserving their invariants).
2. **Flat `docs/`** with a strong `docs/index.md` — no Diátaxis
   subdirectories.
3. **No narrative case-study doc in the repo.** The "day in the room" story
   stays a standalone HTML artifact; `why-acc.md` + `concepts.md` carry the
   opinion.
4. **Bold cuts.** Trim depth aggressively; relocate deep design memoirs to
   `docs/internal/` or drop them; kill duplication hard.
5. **Voice:** opinionated, example-driven on-ramp (`why-acc`, `concepts`,
   `getting-started`); neutral, precise reference (`cli`, `mcp`, `protocol`,
   `capabilities`, `configuration`).
6. **English throughout** (repo content is English; this is unchanged).
7. **Execution deferred** to a fresh branch after the in-flight codex feature
   (session resume / inbox-reply / skill guidance) lands, coordinated via ACC
   before any `tests/**` edit (§8).

## 3. Target information architecture

Filenames are lowercase-kebab (open question O-1 in §10 — keep `UPPER_SNAKE`
instead to cut churn).

### Root
| File | Role |
|---|---|
| `README.md` | Opinionated hook + two-command install + "what the room holds" + link to `docs/index.md`. Ships in the tarball (digest). |
| `AGENTS.md` | Slim contributor/agent entry: the invariants + "prove the gate with a mutation", pointing into `docs/`. |
| `CHANGELOG.md` | Unchanged format (auditable `Built from` digest rows). |
| `SECURITY.md` | Vulnerability-reporting policy (GitHub convention). |

### `docs/` (flat)
| File | ← source | Treatment | Bold move |
|---|---|---|---|
| `index.md` | — | — | **NEW.** The one map: reading paths by audience (§3.1). |
| `glossary.md` | — | neutral | **NEW.** One definition per term (participant/session/generation, intent/claim, workstream/task, guarded/advisory, managed/manual, online/stale/offline). |
| `why-acc.md` | WHY_ACC | opinionated | Positioning + "when to choose a different layer". |
| `concepts.md` | CONCEPTS | opinionated | **Canonical home** for "messages are data, not orders" and "nothing ACC writes lands in your repo". The five ideas; intent vs claim. Trim. |
| `getting-started.md` | GETTING_STARTED | opinionated | First run install→coordinate→uninstall. Keeps the five `acc` verbs + "MCP" (test). |
| `cli.md` | CLI | neutral ref | Pure reference for all 22 commands. Rationale essays (ownership generations, decision-authority laundering) move to `protocol.md`/`concepts.md`. |
| `mcp.md` | MCP | neutral ref | **Canonical home** for native-vs-MCP and "advisory when an MCP client is present". |
| `protocol.md` | PROTOCOL | neutral ref | Vocabulary + interfaces + delivery lifecycle + the 7 attention rules ("seven explicit rules", test). |
| `capabilities.md` | CAPABILITIES | neutral ref | Per-client matrix + deny/inject contracts. Ships in the tarball (digest). |
| `configuration.md` | CONFIGURATION | neutral ref | `acc.workspace.json` schema + the **full env-var reference** (load-bearing test). Two clear sections: "when you need it" vs the raw reference. |
| `troubleshooting.md` | TROUBLESHOOTING | how-to | Symptom → fix; per-client gotchas (Codex trust, Gemini `auto_edit`, Kimi pileup, advisory meaning). |
| `adapter-authoring.md` | ADAPTER_AUTHORING | neutral ref | Keeps the five API tokens `normalizeHook`/`planInstall`/`denyOutcome`/`capabilities`/`defineAdapter` (test). |
| `architecture.md` | ARCHITECTURE | contributor | Control-plane boundary, packages, storage port, discovery, lazy materialisation, the **7 attention kinds** (test). Deep presence/pid-reuse memoir → `internal/`. |
| `design-decisions.md` | DESIGN_DECISIONS | explanation | Settled/rejected/open + the two reversals (0.1.7, 0.1.11). Trim. |
| `security.md` | SECURITY_MODEL + THREAT_MODEL | neutral | **Merge**: trust levels + injection rules + the 10-scenario threat table into one doc. |
| `releasing.md` | RELEASING | maintainer | The gate, verify-package, digest recording. Trim. |
| `examples/three-workstreams.md` | examples | how-to | Keep, trim. |
| `examples/non-git-research.md` | examples | how-to | Keep, trim. |

### `docs/internal/` (relocated out of the user tree)
- The existing `docs/superpowers/` plans + specs (this spec included, until the
  work lands).
- The deep presence/pid-reuse design memoir extracted from `architecture.md`,
  if judged worth keeping; otherwise dropped.

### 3.1 The reading spine (`docs/index.md`)
Five labelled paths, each an ordered short list:
1. **Evaluate** — `why-acc` → `concepts` → `capabilities`.
2. **Get started** — `getting-started` → `configuration` → `troubleshooting` → `examples/`.
3. **Reference** — `cli` · `mcp` · `protocol` · `configuration` · `capabilities`.
4. **Build an adapter** — `adapter-authoring` → `protocol` → `capabilities`.
5. **Secure & contribute** — `security` (trust model + threat scenarios, merged) · `architecture` · `design-decisions` · `AGENTS` · `releasing`.

Every doc is reachable from `index.md` (fixes the current orphans:
ARCHITECTURE, RELEASING, SECURITY_MODEL, THREAT_MODEL). `glossary.md` is
linked from the index header and from first use of any term.

## 4. Per-file content outline

Brief outline; the writing phase expands each. "CUT" = removed or moved to
`internal/`.

- **README** — the hook (a real collision the room prevents), two-command
  install, "what the room holds" (presence/claims/messages/handoffs in one
  table), zero-deps + local-only, link to `docs/index.md`. CUT: the doc-tier
  list (moves to `index.md`); keep at most one diagram.
- **index** — the five paths (§3.1) + a one-line "what is ACC" + glossary link.
- **glossary** — ~12 terms, one line each, each linking to its canonical home.
- **why-acc** — control-plane vs execution-plane; the niche; the negative
  scope ("when a different layer fits"); the decision cue. Opinionated.
- **concepts** — you-become-the-transport; peers-not-workers; the five ideas
  table; **intent vs claim**; claim canonicalization (repo-relative, `file:src/**`
  glob only, normalization); lazy materialisation ("silent when alone").
  Canonical home for "messages are data" + "nothing in your repo".
- **getting-started** — install (just `acc install`), a session attaching by
  itself, `acc status`, a claim conflict (exit 5), a message, `acc uninstall`.
  Native-vs-MCP: one sentence + link to `mcp.md`.
- **cli** — grouped tables (setup / in-session / adapters / about), every one
  of the 22 commands present as `` `acc <name>` `` and bare `acc <name>`; exit
  codes; ownership args summarized (deep rules → `protocol.md`). Neutral.
- **mcp** — the participation tier; register; the ~10 tools; "what you don't
  get"; **canonical native-vs-MCP explanation**.
- **protocol** — identity hierarchy; the interfaces (Intent, Claim, Message,
  Task, Decision, Workstream, Artifact, handoff) with field semantics (the two
  assignee fields); delivery lifecycle; **the seven attention rules**.
- **capabilities** — the measured matrix (with certification caveat); pid
  reality; deny/inject contract tables; install non-uniformity. CUT: prose that
  duplicates `adapter-authoring`.
- **configuration** — when you need a config; the schema table + forbidden
  keys (two reasons); the **complete env-var reference** (every `ACC_*` the
  runtime reads — load-bearing).
- **troubleshooting** — symptom→fix table; the per-client gotchas.
- **adapter-authoring** — manifest + `client.command` dual role; the five API
  tokens; capability honesty rule; normalizeHook whitelist; the deny/inject
  matrix that does NOT port; conformance "run the thing".
- **architecture** — control plane boundary; package table + `core` rule;
  storage port; discovery precedence; lazy materialisation; the 7-rule
  attention table; "a hook never fails closed" budget. CUT: the deep
  presence/pid-reuse treatise → `internal/`, leaving a 3-state summary +
  pointer.
- **design-decisions** — settled/rejected/open; the two reversals with their
  one-line lessons.
- **security** — five trust levels; injection rendering rules; identity/
  generations; claims; privacy in/out lists; the "enforced not documented"
  table; the 10 threat scenarios (prevention/detection/residual); not-in-scope.
- **releasing** — the gate; what verify-package refuses; digest+commit
  recording rationale; publish/OTP.
- **examples** — the two worked scenarios, trimmed to the negotiation beats.

## 5. Deduplication map (canonical home → who links)

| Concept | Canonical home | Everyone else |
|---|---|---|
| native-vs-MCP / "advisory when an MCP client present" | `mcp.md` | README, getting-started, concepts, capabilities, troubleshooting → link |
| "messages are data, not orders" (peer text untrusted) | `concepts.md` | README, getting-started, security → link |
| "nothing ACC writes lands in your repo / platform data dir" | `concepts.md` | README, configuration, troubleshooting, architecture → link |
| work addressed to a participant (survives restart) / two assignee fields | `protocol.md` | concepts, cli → one-line + link |
| the 7 attention kinds | `architecture.md` (table) + `protocol.md` (rules) | kept in sync — **test-enforced in both** |
| presence model (online/stale/offline) | `architecture.md` (summary) + `internal/` (deep) | capabilities, troubleshooting → link |

## 6. Voice & style rules

- **On-ramp (opinionated):** concrete real examples (e.g. `item.drive`,
  grouped-art-part, the Godot queue), the "problem → without ACC → with ACC"
  beat where it clarifies, affirmative voice (no "without X, without Y" slop),
  no anglicisms, plain over clever.
- **Reference (neutral):** precise, scannable, tables over prose, one fact per
  row, no salesmanship.
- **Global:** ~65-char lines in prose; every term defined once in `glossary`;
  cross-links instead of re-explaining; British/American consistent with the
  current repo; no time/effort estimates.

## 7. Test-contract migration (the `tests/**` work)

Every invariant below is preserved; only the *file the test reads* is
re-pointed to the new name. Enumerated so the writing phase can check each.

| Test | Invariant to preserve | Migration |
|---|---|---|
| `tests/docs/commands.test.mjs` (b) | GETTING_STARTED contains `acc install/status/claim/message/uninstall` + `MCP` | point at `docs/getting-started.md` |
| `commands.test.mjs` (c) | CLI names every one of 22 commands as `\bacc X\b` | point at `docs/cli.md` |
| `commands.test.mjs` (d) | ADAPTER guide names the 5 API tokens | point at `docs/adapter-authoring.md` |
| `commands.test.mjs` (a) | every `<!-- test:command -->` block runs `ok:true` from clean state | keep marked blocks only on side-effect-free commands |
| `tests/docs/executable.test.mjs` | every documented `acc`/`{{ACC}}` command is parser-accepted (no exit 2); `checked > 15`; ≤2 `test:illustration`; no unset `$VAR` in a command block | applies to any doc; keep the counts |
| `tests/docs/diagrams.test.mjs` | mermaid blocks type-prefixed; sequence diagrams `;`-free; parenthesised flowchart labels quoted; `> 2` blocks total | keep across the rewrite |
| `tests/docs/skills.test.mjs` | 4 SKILL.md, identical `## ` headings, taught commands present | SKILL.md is in `packages/**` (codex territory) — coordinate; likely untouched by this rewrite |
| `tests/process/surface-coverage.test.mjs` | `architecture` + `protocol` each name all 7 attention kinds in backticks; protocol says "seven explicit rules"; CLI backtick-exactness (`` `acc X` `` ↔ real command) | point at `docs/architecture.md`, `docs/protocol.md`, `docs/cli.md` |
| `tests/process/session-resolution.test.mjs` | no dollar-expanded `ACC_SESSION` (nor any unprovided dollar-expanded `ACC_*` var) in any `docs/**`/`packages/**`/README md; every `ACC_*` the code reads appears in `docs/*.md`+README | keep the env reference in the config doc; never dollar-expand `ACC_SESSION` |
| `tests/acceptance/recorded-candidate.test.mjs` | packed docs digest matches `CHANGELOG.md` `Built from` | packed set today = README + `docs/CAPABILITIES.md`; if `capabilities.md` is renamed, update the package `files`/`PACKED` list AND re-record the digest via `node scripts/verify-package.mjs` |

**Filename map for tests** (single source of truth for the re-point):
`GETTING_STARTED.md→getting-started.md`, `CLI.md→cli.md`,
`ADAPTER_AUTHORING.md→adapter-authoring.md`, `ARCHITECTURE.md→architecture.md`,
`PROTOCOL.md→protocol.md`, `CAPABILITIES.md→capabilities.md`,
`CONFIGURATION.md→configuration.md`.

## 8. Execution & coordination plan

1. **Do not start** the file rewrite while the codex session
   (`Implementing … session resume … inbox/reply … ACC skill guidance`)
   holds `docs/**`, `packages/**`, `tests/**` and is changing the surface the
   docs describe.
2. When codex's feature lands (its claims released / branch merged),
   **coordinate via ACC** — `acc message --to <codex participant>` (or `acc
   claim` on `docs/**` once free) to confirm ownership hand-over before editing
   `tests/**`.
3. Create a fresh branch off `main` (e.g. `docs/rewrite`).
4. Write order: `glossary` + `index` → reference set → on-ramp → explanation →
   `README`/`AGENTS`. Re-point each test as its target doc is renamed; run
   `npm test` continuously.
5. Re-record the tarball digest (`node scripts/verify-package.mjs`) after the
   README/capabilities changes; update `CHANGELOG.md` `Built from`.
6. Relocate `docs/superpowers/` (and any extracted memoir) to `docs/internal/`.
7. Green `npm test` → PR. Keep the deferred README rework out of this branch
   (or fold it in deliberately, decided at branch time).

## 9. Invariants checklist (the tripwires)

- [ ] `cli.md` names all 22 commands, each as `` `acc <name>` `` **and** bare `acc <name>`.
- [ ] `getting-started.md` has `acc install/status/claim/message/uninstall` + `MCP`.
- [ ] `adapter-authoring.md` has `normalizeHook`, `planInstall`, `denyOutcome`, `capabilities`, `defineAdapter`.
- [ ] `architecture.md` **and** `protocol.md` each name all 7 attention kinds in backticks; `protocol.md` says "seven explicit rules".
- [ ] Every `ACC_*` the runtime reads appears somewhere in `docs/*.md` + README.
- [ ] No dollar-expanded `ACC_SESSION` (nor any unprovided dollar-expanded `ACC_*` var) anywhere in docs/packages md.
- [ ] ≤ 2 `<!-- test:illustration -->` markers, each with a reason.
- [ ] `<!-- test:command -->` blocks only wrap clean-state side-effect-free commands.
- [ ] Mermaid blocks type-prefixed; sequence `;`-free; parenthesised flowchart labels quoted; > 2 blocks total.
- [ ] Packed-doc digest re-recorded after README/capabilities change.
- [ ] Attention-kind count word in `protocol.md` matches the actual kind count.

## 10. Open questions / risks

- **O-1 (filename case):** lowercase-kebab (proposed) vs keep `UPPER_SNAKE` to
  reduce churn. Renaming touches every test path, cross-link, the packed list,
  and the digest.
- **O-2 (SKILL.md):** the 4 shipped skills live under `packages/**` (codex's
  claim) and share command vocabulary. This rewrite likely leaves them alone;
  confirm with codex, since it is doing "ACC skill guidance".
- **O-3 (deep memoir):** keep the presence/pid-reuse treatise in
  `docs/internal/` as an archived design note, or drop it entirely.
- **R-1:** codex's feature may add/rename commands or attention kinds; the
  rewrite must target the **post-codex** surface, or the counts drift.
- **R-2:** the deferred README rework (currently uncommitted on the working
  tree) overlaps the README rewrite here — reconcile at branch time.
