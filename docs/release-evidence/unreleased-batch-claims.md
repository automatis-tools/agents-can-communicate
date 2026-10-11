# Unreleased — atomic batch claim and release

This development candidate implements issue #290. It is not a published release.
The package still declares version 0.10.4; these candidate bytes differ from the
published 0.10.4 artifact, whose original record remains unchanged.

## Source and artifact

| Fact | Value |
|---|---|
| Source commit | `6eb44d324b4bd9a248f334506a994c77fe9e1577` |
| Source state at pack time | clean feature worktree |
| Archive | `agents-can-communicate-0.10.4.tgz` |
| Archive size | 588,255 bytes |
| Packed files | 354 |
| SHA-256 | `0f7ec890fc2b5da2d3d9bf3701bfd670eafb475be2a29dd1d0888040f3b4c1a1` |
| Local environment | macOS, Node 24.4.0 |

`npm ci` completed. The syntax gate checked 749 tracked modules. The exact archive
passed `node scripts/verify-package.mjs <archive>` in an isolated consumer with no
workspace symlinks. It exercised all three binaries, doctor, a non-Git workspace,
and client install/uninstall. The supplied-archive verifier cannot infer source
provenance; the source commit above was captured while the worktree was clean
immediately before packing.

## Batch evidence

- Installed CLI callers ran in independent processes with overlapping batches.
  One acquired its whole set; the loser retained no unique prefix.
- A release containing an owned and a foreign claim failed without changing claims
  or events. Release-all left the peer's claims intact and kept presence open.
- Installed MCP exercised array acquisition/release, scalar compatibility, empty
  release-all, and unchanged leases after conflict.
- Installed generation checks rejected close/replacement races for batch writes.
- A mutation that used sequential acquisitions left three claims instead of two
  and renewed an earlier MCP claim. Both installed boundary checks failed.
- Core mutations removed ownership, generation, conflict, duplicate, and atomic
  release protections. Focused regression checks failed and passed after restoration.
- CLI and MCP text tests caught missing requested resources and owner identities.
  The review fix exposes those details while retaining structured batch errors.
- Documentation checks ran 142 commands from guides and bundled skills.

## Limits

This candidate changes no native adapter capability, record schema, journal format,
or store contract. No live vendor-client capability capture or runtime deployment
was performed. Existing journal recovery tests cover the unchanged storage path;
no new batch-specific machine-crash capture is claimed.

