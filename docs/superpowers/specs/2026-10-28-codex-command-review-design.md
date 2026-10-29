# Local ACC commands and Codex approval

The user authorized diagnosis and correction of the false rejection of a local
history read. Codex 0.165.0 classified `acc://` as an external destination before
running ACC. Its retained transcript omitted the skill's local-storage facts,
and the exact escalation request had no justification.

## Approach

Keep the installed participant rule and the existing permission boundaries.
Start commands with default permissions. Escalate only after a sandbox access
failure, with an operation-specific explanation in the exact approval request.
Keep reviewer denials distinct from sandbox failures. Do not change reviewer
policy, global permissions, room identity, or the existing idempotent send retry.

Alternative approaches considered: always escalating with a reason still causes
avoidable reviews; expanding global grants or disabling review changes security
policy. Neither is needed. This choice is an implementation decision within the
user's authorized bug fix, not a new product preference attributed to the user.

Correct diagnostics that equate an installed rule with runtime approval. Preserve
exact ownership checks for old generated rules and all operator edits.

## Acceptance

- The installed skill starts commands with `use_default` and supplies exact
  read and send escalation examples with local destinations and side effects.
- A real Codex against a deterministic local model executes the packed ACC
  wrapper, reads an exact historical message, and leaves its receipt unchanged.
- Explicit escalation reaches the reviewer with the skill's justification;
  a denial prevents command execution. No retry circumvents that denial.
- A restricted profile can still deny state access with a rule present. The
  test accepts that real denial, then proves the explicit local state grant
  works without the rule or review. It does not infer access from writable temp.
- Existing edited-rule preservation and install/uninstall contracts remain true.

The model endpoint is a fixture, not an OpenAI model. Its evidence proves client
routing, context propagation, sandbox enforcement and ACC effects. It cannot
guarantee every future reviewer judgment or autonomous model compliance. The
send retry begins at runtime admission denial, not after an already-recorded
transport failure; existing idempotent-send tests cover the latter. Native IDE captures establish the
original rejection and the successful justified local read in the user's session.
