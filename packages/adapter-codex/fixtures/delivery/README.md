# Codex native delivery captures

These redacted fixtures record only what an installed client actually exposed. A
`result` of `fail` is a boundary finding, not a test failure, and does not certify native
delivery.

`codex-cli-0.152.0.json` was captured on macOS arm64. The generated experimental schema
contains `turn/start` with `clientUserMessageId`, `turnTrigger`, and standalone
`toolOutput`. The installed daemon control socket was absent, so the bounded spike did
not launch `codex app-server proxy`, start a daemon, resume a thread, or attempt a turn.
Every runtime branch is therefore explicitly `unobserved`.

The capture intentionally excludes thread ids, user content, socket paths, home paths,
transcripts, credentials, and raw protocol traffic.

`codex-cli-0.152.1.json` records the first passing capture, on macOS arm64, produced by
`scripts/spikes/codex-queue-fixture.mjs` from the probe's closed result lines plus the ACC
answer ids and the operator's attested busy verdict. The ordinary `codex` command attached
to the ACC-created daemon with `--remote unix://`; idle (a queued submission woke the idle
thread), busy (presented after the turn), reply (real ACC answers through `acc reply`),
duplicate (the same queued submission on retry), and fallback (queued after `daemon stop`)
were all observed. Limitations name what the capture did not cover, including the missing
native idempotency after a submission is consumed. `COMPATIBILITY.md` has the timeline.

`codex-cli-0.152.1-remote-workspace.json` is the capture that supersedes it, taken through
the shipped adapter on a real client. The transport worked; what it revealed is that in
`--remote` mode both the hook payload and the App Server's thread record report the
daemon's directory as the session's, so ACC cannot tell which workspace the session is in.
Every branch is `unobserved` because a session ACC cannot place is never addressed. The
capability is withdrawn, the passing capture stays as history rather than being rewritten,
and only the failure capture ships. `COMPATIBILITY.md` has the full account.
