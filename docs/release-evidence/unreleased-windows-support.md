# Unreleased — native Windows (#234)

Development evidence for the native Windows work. The design and the measurements it rests on are
in [docs/design/2026-09-30-native-windows-support.md](../design/2026-09-30-native-windows-support.md).

## Baseline on windows-latest

Measured on branch `measure/windows-suite` (main `c08c86d` plus measurement workflows), GitHub
`windows-latest` (Windows build 26100, Node 24.21.0, x64), run 36672046716:

| | |
|---|---|
| Tests | 2,636 |
| Failed | 986, in 205 files |
| Skipped | 39 |

The largest causes: a directory `fsync` refused with `EPERM` (153 failures), an `fchmod` on a
directory handle refused with `EPERM` (154), and a store that could not open because of either,
which failed most of the rest. Fixture digests differed because Git for Windows checked the files
out with CRLF.

## Candidate

| Candidate artifact | Value |
|---|---|
| Built from | `7891c5d8aa23dd062722fce0a1b84fe8ef3fbec8` |
| Tarball | `agents-can-communicate-0.8.5.tgz`, 522,540 bytes, 327 files |
| sha256 | `534bc29a02a2bcd5aefc14891d1243f4fd98bed92e37055f15e899e1b0933724` |

Measured with `npm pack` on macOS. Verification on Windows is in progress.
