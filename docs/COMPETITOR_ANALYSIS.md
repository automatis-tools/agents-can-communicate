# Competitor analysis

Research date: 2026-08-15. Primary project and vendor documentation was preferred over popularity metrics.

## Claude Code Agent Teams

Source: <https://code.claude.com/docs/en/agent-teams>

Strengths:

- shared tasks with dependencies;
- direct teammate messaging;
- automatic delivery and idle notifications;
- independent context windows;
- a human can inspect and message individual teammates.

Limits relative to ACC:

- every participant is a Claude Code session;
- a lead creates and manages the team;
- it is an execution topology rather than a vendor-neutral project awareness layer;
- agent teams do not provide worktree isolation by default.

Borrow:

- task dependency behavior;
- direct peer communication;
- visible roster and states;
- coordinator not required as a message relay.

## MCP Agent Mail

Source: <https://github.com/Dicklesworthstone/mcp_agent_mail_rust>

Strengths:

- closest direct feature competitor;
- persistent identities, inboxes, threads, acknowledgements, search;
- advisory file reservations and build slots;
- support for Claude Code, Codex CLI, Gemini CLI, and generic MCP clients;
- macro operations for smaller models;
- Git archive plus SQLite index, TUI, and web UI.

Limits relative to ACC's target:

- agents still explicitly register, fetch, reserve, and acknowledge through tools or macros;
- the large MCP surface consumes attention and context;
- Git is central to the storage model;
- lifecycle attachment and safe-point delivery are not a uniform cross-harness guarantee.

Borrow:

- reservation semantics;
- threaded messages and acknowledgements;
- high-level macros rather than requiring many low-level calls;
- threat-model discipline.

Avoid:

- exposing dozens of model-facing tools when six high-level operations can cover the common workflow.

## Agent Relay

Source: <https://github.com/AgentWorkforce/relay>

Strengths:

- explicit harness adapter contract;
- capabilities describe lifecycle, delivery modes, and observable events;
- durable messages first, realtime events second;
- offline inbox fallback;
- humans can be first-class participants;
- the relay can attach to a process without necessarily owning it.

Limits relative to ACC's target:

- broader messaging/workspace product surface;
- channels and chat are more central than resource conflict prevention;
- some workflows emphasize spawning and driving harnesses;
- project-local zero-command attachment is not the central product promise.

Borrow:

- exact capability declarations;
- delivery receipts and state transitions;
- durable/realtime separation;
- humans as protocol participants.

## Gas Town

Sources:

- <https://github.com/gastownhall/gastown>
- <https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md>

Strengths:

- persistent work ledger and handoffs;
- many provider integrations;
- clear integration tiers from terminal fallback through hooks and deep integration;
- graceful degradation;
- loose coupling through CLI, environment, and JSON contracts;
- explicit principle that the framework supplies transport while agents decide what to do.

Limits relative to ACC's target:

- heavy and opinionated workspace manager;
- owns tmux/process lifecycle and role vocabulary;
- Git/worktree/merge-queue concerns are part of the core workflow;
- one factory topology is imposed on agents that may already be independently open.

Borrow:

- adapter capability tiers;
- config-driven provider integration;
- graceful degradation;
- separation between transport and cognition.

Avoid:

- permanent Mayor-style authority;
- tmux or terminal scraping as the primary integration.

## agent-mux and switchboard-style tools

Source: <https://github.com/buildoak/agent-mux>

Strengths:

- unified adapter boundary for Codex, Claude, and Gemini;
- normalizes provider CLI output;
- useful for cross-model review and delegated execution.

Limits relative to ACC's target:

- dispatches or invokes external CLIs as workers;
- emphasizes one-shot tasks and result collection;
- does not primarily solve ambient awareness among independently human-driven sessions.

Borrow:

- normalized adapter result envelopes;
- compact context packages;
- explicit worker identity.

## Gemini extensions and A2A

Sources:

- <https://geminicli.com/docs/extensions/>
- <https://geminicli.com/docs/hooks/>
- <https://geminicli.com/docs/core/subagents/>
- <https://a2a-protocol.org/dev/specification/>

Gemini extensions can bundle hooks, skills, MCP servers, policies, and subagents. Gemini can also connect to remote subagents through A2A.

A2A contributes portable concepts:

- agent capability cards;
- stateful tasks;
- messages distinct from produced artifacts;
- asynchronous operation and capability negotiation.

ACC should align internal names and envelopes where practical, but local v1 should not require every human-driven CLI session to expose an A2A HTTP server.

## MCP itself

Source: <https://modelcontextprotocol.io/specification/2024-11-05/server/tools>

MCP is the correct generic tool surface. It is not a lifecycle or user-experience guarantee. Tools are model-controlled, and the specification deliberately does not mandate the host interaction model.

Therefore:

- MCP-only clients use explicit sync/polling;
- native adapters add attach, safe-point injection, and write guards;
- ACC never claims MCP can wake a dormant model.

## Strategic conclusion

ACC should not compete as “mail for agents” or “a manager that spawns many agents.” Its defensible product position is:

> Automatic, low-noise, project-wide awareness and conflict prevention across already-open, independently owned sessions from different agent vendors.

The moat is the combination of:

- zero-command native attachment;
- first-class informal Intent;
- project-global resource claims;
- optional workstreams instead of one permanent leader;
- capability-truthful adapters;
- compact delta context;
- local-first operation without Git, tmux, PostgreSQL, or cloud requirements;
- a protocol that can later map to A2A for remote participants.
