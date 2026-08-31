# ACC documentation

ACC (agents-can-communicate) is a local-first coordination layer for independent AI coding sessions working the same repo: they see who else is here, claim the files they touch, message each other directly, and hand work across — while you go back to directing. The pitch and install are in the [project README](../README.md); this is the map.

Pick the path that matches why you're here.

## Evaluate — is this for me?
1. [Why ACC](WHY_ACC.md) — the niche it fills, and when a different layer fits better.
2. [Concepts](CONCEPTS.md) — the model: peers not workers, the handful of ideas everything else rests on.
3. [Capabilities](CAPABILITIES.md) — what actually works, measured per client.

## Get started — install and run it
1. [Getting started](GETTING_STARTED.md) — install, a session attaching by itself, your first coordinated moves, uninstall.
2. [Configuration](CONFIGURATION.md) — when you need `acc.workspace.json`, and the full environment reference.
3. [Troubleshooting](TROUBLESHOOTING.md) — symptom → fix, and the per-client gotchas.
4. Worked scenarios: [three workstreams on one repo](../examples/three-workstreams.md) · [research in a plain folder](../examples/non-git-research.md).

## Reference — the exact surface
- [CLI](CLI.md) — every command, its flags, and exit codes.
- [MCP](MCP.md) — the participation tier for clients without a native adapter, and its tools.
- [Protocol](PROTOCOL.md) — the vocabulary, the object model, and the delivery lifecycle.
- [Configuration](CONFIGURATION.md) — the `acc.workspace.json` schema and every `ACC_*` variable.
- [Capabilities](CAPABILITIES.md) — the per-client matrix and the deny/inject contracts.

## Build an adapter — teach ACC a new client
1. [Adapter authoring](ADAPTER_AUTHORING.md) — the manifest, capabilities, and the install/hook contract.
2. [Protocol](PROTOCOL.md) and [Capabilities](CAPABILITIES.md) — the interfaces and the per-client reality your adapter must respect.

## Secure & contribute
- [Security model](SECURITY_MODEL.md) — trust levels, prompt-injection rules, and the threat scenarios.
- [Architecture](ARCHITECTURE.md) — the control-plane boundary, packages, and the presence model.
- [Design decisions](DESIGN_DECISIONS.md) — what's settled, what's rejected, and two reversals worth reading.
- [Contributing](../AGENTS.md) — the invariants and how to prove a gate with a mutation.
- [Releasing](RELEASING.md) — the release gate and the recorded package digest.

---

New to the vocabulary? The [Glossary](GLOSSARY.md) defines every term in one line — participant vs session, intent vs claim, guarded vs advisory, and the rest.
