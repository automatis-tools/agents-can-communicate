# ACC documentation

ACC adds peer awareness and communication to AI sessions you open yourself. You continue
to give each agent ordinary work; supported integrations tell agents about their peers and
teach them how to coordinate when it is useful. The agents remain independent, and each
decides what its task requires.

## Start here

1. [Getting started](GETTING_STARTED.md) — install ACC, open two sessions, give them related
   tasks, and know what coordination to look for.
2. [Why ACC](WHY_ACC.md) — decide whether independent peer coordination fits your work.
3. [Capabilities](CAPABILITIES.md) — check what your client and platform can actually do.
4. [Troubleshooting](TROUBLESHOOTING.md) — diagnose missing peers, queued messages, and
   capability fallback.

## See it in context

- [Three agents, one repository](https://github.com/automatis-tools/agents-can-communicate/blob/main/examples/three-workstreams.md)
  — related implementation tasks with direct dependency questions and advisory claims.
- [Research without Git](https://github.com/automatis-tools/agents-can-communicate/blob/main/examples/non-git-research.md)
  — two local sessions sharing findings in a plain folder.

## Understand the system

- [Concepts](CONCEPTS.md) — peers, workspaces, durable threads, receipts, intent, and claims.
- [How ACC works](HOW_IT_WORKS.md) — the path from integration awareness through durable
  storage, delivery fallback, reply, and acknowledgement.
- [Protocol](PROTOCOL.md) — message envelope, thread rules, receipt lifecycle, handoffs,
  bindings, and the clean v0.2 store break.
- [Architecture](ARCHITECTURE.md) — record-first flow, package boundaries, router, storage,
  and hooks.
- [Security model](SECURITY_MODEL.md) — untrusted peer content, delivery integrity,
  filesystem boundaries, and executable attack tests.
- [Adapter authoring](ADAPTER_AUTHORING.md) — capability evidence, hook contracts, and
  installation ownership.
- [Glossary](GLOSSARY.md) — each public term in one line.

## Reference

- [CLI](CLI.md) — exact commands, flags, result shapes, and exit codes.
- [MCP](MCP.md) — durable polling for clients without a native adapter.
- [Configuration](CONFIGURATION.md) — optional workspace identity and policy.

## Project work

- [Contributing](https://github.com/automatis-tools/agents-can-communicate/blob/main/AGENTS.md) — invariants and the mutation-proof gate.
- [Design decisions](DESIGN_DECISIONS.md) — architectural decisions and reversals.
- [Releasing](RELEASING.md) — packed-artifact verification.

Runtime state and raw transcripts are not documentation artifacts and never belong in the
repository.
