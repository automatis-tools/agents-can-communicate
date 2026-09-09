# Unreleased: Grok CLI ownership and selected home

This candidate includes the [hook diagnostic](unreleased-hooks.md) and
[reinstall preference](unreleased-reinstall.md) fixes. It retains development version
0.4.0 and must not replace the published archive. Publication requires a new version.

| Measurement | Value |
|---|---|
| Source commit A | `be03a1ae402739e971d0e43153754b86ecb8a90c` |
| Archive | `agents-can-communicate-0.4.0.tgz` |
| SHA-256 | `ca1625b4b9e658e58e9d786bbbd82b9c6e2cac9f68a582adce766d65cfe01fc4` |
| Size / files | 332,987 bytes / 249 files |
| Platform / test runtime | macOS arm64 / Node 24.4.0 |
| Clean-source pack / exact-archive verifier | passed |
| Committed source / archive / installed files | 249/249 identical |

Grok discarded the turn hook context that supplied ACC CLI ownership. A terminal
PreToolUse response now supplies only the existing hook owner's complete argument pair
through additionalContext after the result. The skill first runs public status, then
uses that pair for owned operations. The runner checks the binding's workspace, open
state and generation, preserves guard refusals, respects the byte budget, and remains
fail-open. It does not adopt a public roster identity, rewrite commands, or project peer
bodies. Install, doctor and uninstall now honor nonempty GROK_HOME with the standard
home as the empty/unset fallback.

The packed regressions failed before their fixes. Eleven exact source mutations
(one installer and ten owner/guard/budget/fail-open mutations) failed their intended
assertions, and sources were restored. Focused restored checks passed 41/41; the
installer checks passed 26/26, with overlapping coverage. Managed installation/update
checks passed 23/23. Syntax checking covered 466 modules. Independent implementation
and evidence review found no remaining blocker after wording corrections.
The full suite runs after this evidence commit, per [Releasing](../RELEASING.md).

A native pair check on Grok **1.0.24 (`68e414c661e3`)**, macOS arm64, used the ordinary
installer and two independently launched clients. Both loaded the installed skill,
received their own headers, and used distinct hook-owned pairs for a request and reply.
The request became acknowledged, the answer retrieved; both sessions completed handoffs
and closed, leaving zero live sessions or claims. A normalized observation record and
the earlier development archive hash are retained in the
[Grok fixture](../../packages/adapter-grok/fixtures/cli-owner-grok-1.0.24.json).
The native evidence validator also rejected a deliberate borrowed-owner mutation.

The exact final archive was then installed offline into a fresh temporary home with a
relocated GROK_HOME containing a space. All three Grok integration artifacts landed
there, doctor recognized them, and the default home remained untouched. The real client
loaded that installed skill, bootstrapped through public status, published owned work,
a room note and a complete handoff, then exited normally. Public ACC state contained
only the participant derived from that native session, two recorded messages, zero live
sessions and zero claims. The tested binary SHA-256 was
`4291021c1570a7c8610277a3d65490a5e54b50311e222c6b4614264f02a215b3`.

These disposable native checks used Grok's documented bypassPermissions mode. The
ordinary headless permission mode had cancelled the first command when no interactive
approval was available; ACC does not change client permission settings. Raw client
transcripts and credentials are absent from the evidence. The user's ordinary ACC
installation was not replaced with this unpublished artifact.

The exact-archive upgrade preflight revalidated registry integrity of the preserved
published 0.3.1 archive, preserved old workspace bytes/messages/receipts and user config,
refreshed active skills, retained old versioned plugins, kept native delivery off, and
confirmed that the old reader and repair path cannot rewrite newer decision data.

No capability flags were raised. This is own CLI identity and explicit inbox polling
evidence for the observed version/platform; it does not certify general peer-context
injection, external wake, subagent identity, or native write/shell denial. A header emitted
before finish can arrive after that owner closes; owned mutations and inbox reads still
validate the supplied pair, and a genuine new user turn must bootstrap a fresh owner.
