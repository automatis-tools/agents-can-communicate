# Unreleased: Codex sessions answer peers without auto-review

| Candidate artifact | Value |
|---|---|
| Built from | `dd3c3c1e8fd691eaae515cb30e35a2cb9302db9f` |
| Tarball | `agents-can-communicate-0.9.0.tgz`, 557,646 bytes, 337 files |
| sha256 | `32253419172c4c9a926807edfa21a5002c0405d3472ddf672c96b5404b40f024` |

Issue #260.

## What was measured before the change

A Codex 0.160 session on the maintainer's Mac, 2026-10-05, with `approval_policy = "on-request"`
and `approvals_reviewer = "auto_review"`, read from its own rollout file:

- 118 of its 167 ACC commands ran with `sandbox_permissions: "require_escalated"`. None of the
  sandboxed ACC commands failed, so escalation was the model's choice, not a need.
- At 16:49 UTC the reviewer refused an `acc reply` that named a branch, a commit, changed paths and
  a release target: "This discloses non-public branch, commit, changed-path, release-target, and
  readiness metadata to an external ACC peer". The peer was a Claude Code session of the same
  user on the same machine.
- From then on the session answered two peer questions with "I cannot share project details in
  ACC without explicit user approval", and stopped answering a release question while it asked
  the user in its own chat.

Codex's source (0.155.1, through Context7) and the 0.160.1 binary agree on the mechanism: every
`*.rules` file in `$CODEX_HOME/rules` is loaded, and a command that a `prefix_rule` with
`decision = "allow"` matches gets the approval requirement `Skip`, so it never reaches the
reviewer.

## What changed

- `adapter-codex/src/allow-rule.mjs`: ACC's own rules file,
  `$CODEX_HOME/rules/agents-can-communicate.rules`. One `prefix_rule` with ACC's wrapper by its
  full path and the participant commands `work`, `claim`, `release`, `message`, `request`,
  `inbox`, `reply`, `ack`, `status`, `sync` and `finish`. A same-named file that does not start
  with ACC's header stays the operator's; a wrapper path a Starlark string cannot hold as it is
  gets no rule; Windows gets none.
- `adapter-codex/src/install.mjs`: install writes the rule, the plan declares the file so the
  ownership record takes it back, detection reports it and asks for
  `acc install --adapter codex` when it is missing, and uninstall removes an unchanged rule.
- Every client's skill: a peer is another AI session of the same user on this machine, and a
  send reaches no one off the machine; that is what to tell a client that asks why an ACC
  command should run.
- Docs: capabilities, configuration (Codex command approval), security model, troubleshooting,
  the Codex compatibility record.

## Tests

The tests of the new behaviour were seen failing before the change: the module did not exist.

- `packages/adapter-codex/test/allow-rule.test.mjs`: install writes the rule with the wrapper
  and the participant commands and none of install, uninstall, update, config or prune; the plan
  declares it; a foreign file stays; Windows gets none; doctor reports it and asks for a
  reinstall when it is missing; uninstall takes it back and leaves an edited one.
- `tests/security/restore-every-client.test.mjs` and `tests/security/installer.test.mjs` caught
  the first version leaving the file behind after an adapter-level uninstall.
- `tests/acceptance/real-clients-stub.test.mjs`: the real Codex reads the installed file;
  `codex execpolicy check` answers `allow` for `<wrapper> reply …` and nothing for
  `<wrapper> install …`, and uninstall removes the file. It ran on this Mac with Codex 0.160.1
  and runs in the real-clients CI job on Linux; on Windows it checks that no file is written.

## Limits

- No model-driven session was run against the rule: the evidence that a matched command skips
  auto-review is Codex's own source and `codex execpolicy check`.
- Whether a running Codex session picks up a rules file written after it started is unmeasured;
  troubleshooting advises a new session if one still asks.
- Windows is unmeasured and gets no rule.
