# Agents Can Communicate

Agents Can Communicate (ACC) is a local-first coordination layer for independent AI-agent sessions. Its goal is to let Codex, Claude Code, Gemini CLI, and other compatible clients understand who else is active, what each participant is doing, which resources are claimed, what decisions were made, and what needs a response.

ACC is not another subagent framework. It does not require one model to own or launch the others. Each participant keeps its own conversation, permissions, model, context window, and human relationship. ACC supplies the shared coordination plane above those separate harnesses.

## Repository status

This repository is a design and migration handoff, not a released package.

- The validated Papercut Warzone 2 prototype is preserved under `prototype/papercut-agent-comms/`.
- Four independently verified but not yet combined hardening patch sets are preserved under `migration/patches/`.
- The approved standalone architecture and product UX are documented under `docs/`.
- Detailed execution plans are under `docs/superpowers/plans/`.
- No standalone runtime or published npm package exists yet.

Do not treat the prototype as the target architecture. It is evidence, reusable behavior, and a regression suite.

## Start here

For a new agent session, read these files in order:

1. [`AGENTS.md`](AGENTS.md)
2. [`docs/PROGRESS.md`](docs/PROGRESS.md)
3. [`docs/DECISIONS.md`](docs/DECISIONS.md)
4. [`docs/superpowers/specs/2026-08-15-standalone-acc-design.md`](docs/superpowers/specs/2026-08-15-standalone-acc-design.md)
5. [`docs/ROADMAP.md`](docs/ROADMAP.md)
6. [`docs/NEXT_SESSION.md`](docs/NEXT_SESSION.md)

## Product shape

The currently selected direction is:

- npm/npx CLI plus adapter packages;
- native integrations for Codex, Claude Code, and Gemini CLI;
- generic MCP fallback for other clients;
- local-only and same-machine in the first release;
- Git enrichment when available, but no Git requirement;
- automatic session attachment with optional project configuration;
- runtime state outside the project repository;
- project-wide awareness and claims;
- optional workstreams and coordinators, rather than one permanent global orchestrator.

The design direction was fully approved on 2026-08-15; the remaining open technical decisions (storage backend, package names, license, and similar) are recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Prototype verification

The imported baseline is kept runnable in its original directory shape:

```bash
npm run test:prototype
```

The archived hardening patches were tested independently in the source repository. They overlap and must be integrated deliberately; see [`migration/README.md`](migration/README.md).

## Remote

Canonical repository:

```text
git@github.com:automatis-tools/agents-can-communicate.git
```
