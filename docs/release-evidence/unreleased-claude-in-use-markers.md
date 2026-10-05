# Unreleased: the plugin copy a running Claude Code session uses stays

| Candidate artifact | Value |
|---|---|
| Built from | `9d1f8b020700fb1042e84019b0957e3082d1e518` |
| Tarball | `agents-can-communicate-0.9.0.tgz`, 554,998 bytes, 336 files |
| sha256 | `2a1b287f52c69a91deb9b84e4fc886473fa13230061739370645437c41236876` |

Issue #257.

## What was measured before the change

ACC 0.8.5 updated to the published 0.9.0 on the maintainer's Mac (macOS arm64), 2026-10-05,
while a Claude.app local Code session (bundled Claude Code 2.1.286) ran from the 0.8.5 plugin
copy.

- Seven seconds after the update,
  `~/.claude/plugins/cache/acc-local/agents-can-communicate/0.8.5/.in_use/<pid>` appeared, named
  after that session and holding its `pid` and `procStart` in the form of its session record.
- `acc doctor` reported the cache as modified and advised
  `acc install --adapter claude_code  # files were edited`.
- That reinstall runs from the active generation and passes the active version as the one to
  keep, so `keepVersions` keeps 0.9.0 alone and removes the 0.8.5 copy the client had marked.
  This was read from the code, not run on that machine.
- When the session exited, its file went and the empty `.in_use` directory stayed; doctor
  reported nothing again.
- The same markers stand in other plugins' version directories, named after terminal sessions
  and written from under a minute to six minutes after each session started.

## What changed

- `installer`: the tree fingerprint leaves out files in an `.in_use` directory, as it already
  leaves out `.orphaned_at`. A record written before the change fingerprinted a tree with no
  such file, so it stays valid.
- `adapter-sdk`: `keepVersions` keeps a version whose `.in_use` names a live process. A marker
  whose process has exited, an empty `.in_use`, or a file there that names no pid holds nothing.
  A reused pid can at worst keep a copy until the next install. The Codex adapter uses the same
  function; Codex writes no such marker.
- `adapter-claude-code/COMPATIBILITY.md`: the marker's behaviour, as measured.

## Tests

The three tests of the new behaviour were seen failing for their stated reason before the change.
The others pin what must not change, and passed before and after it.

- `packages/installer/test/ownership.test.mjs`: an in-use marker inside an owned tree is not an
  edit; any other added file still is.
- `packages/adapter-sdk/test/own-version.test.mjs`: a version marked by a live process stays; a
  marker of an exited process, an empty marker directory, and a file that names no pid hold
  nothing.
- `packages/adapter-claude-code/test/adapter.test.mjs`: a reinstall with no previous version to
  hold keeps the version a running session marks in use.

## End to end

An earlier candidate of this branch, `72a5311`, repacked as 0.9.99 so the managed runtime takes
it as an update, 2026-10-05. `9d1f8b0` differs from it only in comments and in the compatibility
text. Each run used its own `HOME`, data home and prefix, the published 0.9.0 from npm, a
real Claude Code session against a model stub on 127.0.0.1, and a local registry serving the
candidate. The session started on the 0.9.0 plugin copy; then `acc update` installed 0.9.99.

| Run | Client | Marker awaited | Marker |
|---|---|---|---|
| 1 | Claude Code 2.1.289, terminal | 30 s | none |
| 2 | Claude Code 2.1.289, stream-json | 30 s | none |
| 3 | Claude.app's 2.1.286 executable, stream-json, outside the app | 30 s | none |
| 4 | Claude Code 2.1.289, terminal | 7 min | none |
| 5 | Claude Code 2.1.289, terminal, background traffic allowed | 5 min | none |

In every run:

- doctor after the update reported the cache intact (`modified: []`) and advised nothing;
- `acc install --adapter claude_code` while the session ran removed the unmarked 0.9.0 copy;
- a question sent afterwards reached the model with ACC's hook output, so the session took its
  hooks from the 0.9.99 copy;
- after the session exited, a reinstall left 0.9.99 alone, and doctor reported the cache intact.

No run wrote a marker, so the new behaviour against a real marker is covered by the tests above
only. What writes the marker on the maintainer's machine, a session open for many hours or
Claude.app itself, is unmeasured. The runs also show that removing the previous copy did not
stop a running session on these versions: the harm the issue feared from the reinstall was not
observed.
