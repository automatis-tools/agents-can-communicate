# Getting started

Three minutes, end to end.

The short setup is part of the design: ACC coordinates sessions you already open, so
there is no scheduler, daemon, dashboard, or replacement workflow to start first.

```mermaid
graph LR
  I[acc install] --> S[open your client<br/>as usual] --> P[peers appear] --> C[claims guard writes] --> U[acc uninstall]
```

## 1. Install

Getting the `acc` binary itself: [README](../README.md#install). Then:

<!-- test:command -->
```bash
acc install
```

It only installs for clients you actually have. Missing ones are listed with the reason.

## 2. Open a session — normally

No ACC command. Just start Codex, Claude Code, Gemini, or Kimi as you always do. A hook
attaches the session. It keeps its own client, permissions, checkout, and human
instructions; ACC adds a shared coordination view around it.

## 3. See who is here

<!-- test:command -->
```bash
acc status
```

```text
2 live; 1 claim(s); protection advisory
```

## 4. Claim before touching shared files

Inside a session your agent runs this for you:

```bash
acc claim --resource 'file:packages/core/**' --reason "porting the store"
```

Another session that tries to write there is refused — with the owner's name.

```mermaid
sequenceDiagram
  participant M as models
  participant ACC
  participant V as visual
  M->>ACC: claim file:packages/core/**
  V->>ACC: write packages/core/store.mjs
  ACC-->>V: denied — claimed by models
  M->>ACC: release
  V->>ACC: write packages/core/store.mjs
  ACC-->>V: ok
```

Exit code `5` means conflict.

## 5. Say something

`--to` takes a name from the roster — `acc status` above is where you get it. Using one
nobody here has is refused, and the refusal lists the names there are.

```bash
acc message --to models --subject "Slots" --body "Which names are stable?" --type question
```

Messages are **data, not orders**. A peer cannot change your instructions.

## 6. Optional: shared settings

Nothing above needs a config file. A team adds one when identity has to survive a move, or
when a claim policy should be agreed once rather than per machine:

<!-- test:command -->
```bash
acc config validate
```

With no config present it reports the defaults — not having one is a valid state. See
[Configuration](CONFIGURATION.md).

## 7. Remove it

```bash
acc uninstall
```

Removes only what ACC wrote, and only if it still matches. Anything you edited stays.

## Native vs MCP

```mermaid
graph TB
  N[Native adapter<br/>Codex · Claude Code · Gemini · Kimi] --> NA[attaches by itself]
  N --> NB[guards writes]
  N --> NC[injects peer context]
  M[Generic MCP client] --> MA[attaches on first tool call]
  M --> MB[reads and posts]
  M --> MC[nothing intercepts its writes]
```

An MCP participant shows as `advisory` on the roster, and a workspace with one in it
reports `advisory` protection — a guarded claim is advice while it is connected.

That downgrade is deliberate. MCP is enough to participate in durable coordination, but
it does not expose the lifecycle and write boundaries needed for ambient attachment and
guards. ACC reports the difference instead of presenting both integrations as equivalent.

## Next

[Why ACC](WHY_ACC.md) · [CLI reference](CLI.md) · [Configuration](CONFIGURATION.md) ·
[Troubleshooting](TROUBLESHOOTING.md)
