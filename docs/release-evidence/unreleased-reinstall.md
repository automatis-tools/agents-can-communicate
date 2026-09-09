# Unreleased: automatic-update preference across reinstall

This is a development candidate, not a new publication or a replacement for
[released 0.4.0 evidence](v0.4.0.md). The package still declares 0.4.0; any future
publication requires a new version and the normal release gates.

| Measurement | Value |
|---|---|
| Source commit A | `c389a18067caa260d6ae13b54c7adc2a07d74f76` |
| Archive | `agents-can-communicate-0.4.0.tgz` |
| SHA-256 | `dd69e0fe812b6e9be5eb080f5b847ac8eb0ca7296570bb9295f5e4c9bcc58e47` |
| Size / files | 330,967 bytes / 248 regular files |
| Platform / runtime | macOS arm64 / Node 24.4.0 |
| Clean-source pack / package verifier | passed |

The exact saved archive was installed offline into a fresh temporary prefix using
ordinary npm installation. HOME, ACC data, and the non-Git project were isolated.
Its real CLI reported `auto: true` after initial installation, `false` after full
uninstall, and `true` after reinstall. Explicit `--auto off` remained false through
another full uninstall/reinstall cycle. No production account settings were used.

Before the last help/documentation wording correction, focused packed and runtime
checks passed 20/20. Nine exact source mutations failed their intended assertions:
lost restoration, lost legacy preference capture, repeated-uninstall overwrite,
stale preference overriding an explicit opt-out, pin-only overwrite, premature
resumption after partial uninstall failure, guessing legacy consent, invalid
optional preference acceptance, and disabled uninstall worker shutdown. Each source
file was restored and byte-checked. Existing activation, installation, and update
checks also passed. The final help and installed-help checks passed 21/21, and
syntax checking covered 461 modules. The full suite belongs after the evidence
commit, as described in [Releasing](../RELEASING.md).

The preference remains separate from the operational worker switch. Partial
uninstall failures keep updates paused; reinstalling an unrelated adapter cannot
resume the failed removal. Legacy 0.4.0 records without a saved preference cannot
distinguish uninstall shutdown from an explicit opt-out, so existing false stays
false until the user chooses `acc update --auto on`.

No new native capability is certified by this fix. Separate personal-install E2E
checks used the **published** 0.4.0 archive, SHA-256
`76b96ca1a8ac6f8b2682e5e4e2fe878b57882752ab944cd4239ce16a6721c9a0`,
with Codex 0.153.4, Claude Code 2.1.265, and Gemini CLI 0.57.0. Codex and Claude
exchanged review requests, replies and approval, retrieved the relevant receipts,
left complete handoffs, and exited naturally; final live sessions and claims were
zero. Gemini recorded a note and handoff and likewise left no live session or claim.
Live delivery was off, so these checks establish ordinary CLI/polling participation,
not idle wake or new guard certification. An earlier six-minute harness run was
interrupted and is not counted as the completed E2E.

Grok 1.0.13 did not complete its personal-install smoke: its real `acc message`
invocation lacked owner arguments and returned `caller_identity_unresolved`.
No note was recorded. This remains a separate follow-up; process exit zero does
not establish successful ACC participation. Raw client transcripts were not collected.
