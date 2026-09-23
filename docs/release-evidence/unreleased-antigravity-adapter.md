# Unreleased Antigravity CLI adapter and live delivery

This records the branch that adds the Antigravity CLI adapter and its live delivery
relay. Every client behaviour it relies on is a capture in
`packages/adapter-antigravity/fixtures/`, described in the adapter's
[compatibility notes](../../packages/adapter-antigravity/COMPATIBILITY.md).

## Exact local artifact

- Source: clean commit `57d977b545ea76de38d2ed17850a39ff38f0ed78`.
- Archive: `agents-can-communicate-0.5.10.tgz`, packed from that commit.
- Size: 444,260 bytes; 306 packed entries.
- SHA-256: `32768535131b513b46ca2940c60f9b31971ceca33f429d64865f2a9d66d534f9`.
- Package version remains `0.5.10`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`: pack, contents with no forbidden
entries, six certification manifests with their exact evidence allowlist, packed Markdown
links, bundled workspace versions, clean installation, doctor, no-Git workspace
operations, and install/uninstall byte restoration. Syntax checks passed in 589 files.
The 123 focused checks - adapter, relay, native delivery, relay startup and routing,
activation hint, capture contract and certification floor - passed with no skips.

The final unrestricted `npm test` run, with this record in place, completed 2,418 tests:
2,417 passed, zero failed, and one skipped, in 551 seconds. The skip is the existing
absent-Gemini uninstall case, because Gemini is installed on this machine. The
recorded-candidate gate passed. An earlier run of the previous record had one failure in
`packages/hook-runner/test/native-attempt-doctor.test.mjs`, one of the three tests known to be
load-sensitive; run alone it passed every time.

## Certification floor

Antigravity ships a release every few days. With exact-version certification the first
update after install would have withheld next-turn delivery from every user, so the adapter
declares 1.2.7 on darwin-arm64 as a certification floor (decided 2026-09-21). A later stable
release is judged by the 1.2.7 captures for every capability it has no capture of its own
for; a later capture that records a regression wins for that release and capability.
Earlier versions, prereleases and other platforms stay uncertified. No release after 1.2.7
has been captured.

The relay now runs the `agy` named in `ANTIGRAVITY_AGENTAPI_EXE` when that is an absolute
executable file named `agy` - captured as the same file as the `agy` on the agent's PATH -
and falls back to the PATH otherwise.

## Live delivery capture

On 2026-09-21 a private candidate built from this branch (SHA-256
`fa1dab632b9ec5cef0e391b3779816eb479beaaee6c6197b0b166a24b0cf2887`, the same source with
the native contract switched on) was installed into an isolated ACC data home, and a real
Antigravity CLI 1.2.7 TUI was driven under a private PTY on macOS arm64. The agent ran the
relay command named in ACC's one-time context line; the operator approved it once at the
client's permission prompt. All five branches passed and are recorded in
`fixtures/delivery/antigravity-cli-1.2.7-relay-product.json` with its product evidence:

- idle: a question woke the idle session with no user input;
- busy: a question accepted while the model streamed a 5,288-word answer was held 25 seconds
  and presented after that answer completed;
- reply: the agent's `acc reply` reached the sender and acknowledged the question;
- duplicate: one logical message sent twice kept its id and was pushed once;
- fallback: the relay retired itself about five seconds after the client exited, and the
  next message stayed queued.

The run also showed a push landing at the next model invocation when the turn was waiting on
a tool permission, and that the first TUI session in a folder trusted at that launch gives
every hook an empty `workspacePaths`. Both are limitations in the certification and in
`COMPATIBILITY.md`; the second has its own fixture.

## Regression evidence

The relay startup test runs the hook runner's per-turn re-handshake twice against a live
relay. Giving the adapter a `retireNativeSession` that removes the relay's registration -
what the first design specified - made it fail; the shipped adapter has none, and it passes.

Every test that spawns a relay launcher sets its own `ACC_DATA_HOME`: without one, the
launcher found the managed runtime installed on this machine and ran that generation
instead of the checkout.

## Limits

Live delivery is certified for Antigravity CLI 1.2.7, and later stable releases by the floor
above, on darwin-arm64 in the TUI only. It is
experimental, off until `acc install --adapter antigravity --delivery actionable|all`, and
runs only after the user approves the relay command in the client. Print mode, the first
session in a newly trusted folder, other versions and other platforms keep next-turn and
inbox delivery. `delivery.replyRoute` stays false. The capture ran against the candidate
above, not against this exact archive. The archive adds what the capture produced - the
certification row, the declared contract and its tests - plus the certification floor, the
relay's preference for the client-named `agy`, a doctor line for the newly trusted folder
case, and documentation.
