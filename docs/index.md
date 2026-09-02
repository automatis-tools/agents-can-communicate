# ACC documentation

ACC connects independently opened AI sessions so they can discover peers and communicate
without becoming one managed agent team. This map starts with the useful interaction, then
separates protocol truth from adapter reach.

## Evaluate

1. [Why ACC](WHY_ACC.md) — the product boundary and when a managed runtime fits better.
2. [Concepts](CONCEPTS.md) — peers, durable threads, receipts, intent, and claims.
3. [Capabilities](CAPABILITIES.md) — certified support, current reachability, recipient
   policy, fallback, and limitations beside each adapter.

## Use it

1. [Getting started](GETTING_STARTED.md) — two user-opened sessions complete one useful
   acknowledged question-and-answer interaction.
2. [CLI](CLI.md) — exact commands, flags, result shapes, and exit codes.
3. [MCP](MCP.md) — durable polling for clients without a native adapter.
4. [Configuration](CONFIGURATION.md) — optional workspace identity and policy.
5. [Troubleshooting](TROUBLESHOOTING.md) — symptoms, exact downgrades, and fixes.

## Understand and extend it

- [Protocol](PROTOCOL.md) — message envelope, thread rules, receipt lifecycle, handoffs,
  bindings, and the clean v0.2 store break.
- [Architecture](ARCHITECTURE.md) — record-first flow, package boundaries, router, storage,
  and hooks.
- [Security model](SECURITY_MODEL.md) — untrusted peer content, delivery integrity,
  filesystem boundaries, and executable attack tests.
- [Adapter authoring](ADAPTER_AUTHORING.md) — capability evidence, hook contracts, and
  installation ownership.
- [Glossary](GLOSSARY.md) — each public term in one line.

## Project work

- [Contributing](https://github.com/automatis-tools/agents-can-communicate/blob/main/AGENTS.md) — invariants and the mutation-proof gate.
- [Design decisions](DESIGN_DECISIONS.md) — architectural decisions and reversals.
- [Releasing](RELEASING.md) — packed-artifact verification.

Runtime state and raw transcripts are not documentation artifacts and never belong in the
repository.
